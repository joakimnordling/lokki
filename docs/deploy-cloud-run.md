# Running the sync server on Cloud Run

The workflow [deploy-server.yml](../.github/workflows/deploy-server.yml) builds `servers/python` into a container
image and deploys it to Google Cloud Run whenever the server changes on `main`, or when started by hand. It can deploy
several servers, for example one storing in PostgreSQL and one in Firestore. The app syncs with all of them.

Each deployment:

- runs at most one instance, and none while nobody syncs (scale to zero). The first sync after a quiet spell waits a
  few seconds for the server to start; the app's requests allow for that.
- needs no stored keys: GitHub Actions signs in to Google Cloud with Workload Identity Federation, and the server
  signs in as its own service account.
- keeps the only secret, a PostgreSQL URL with its password, in Secret Manager. A Firestore server has no secrets.

This is the one-time setup. Replace the values in capitals.

## 1. The Google Cloud project

```sh
PROJECT=YOUR-PROJECT-ID
REGION=europe-north1            # Finland; Cloud Run and Firestore are both available there
gcloud config set project $PROJECT
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com
```

A repository for the images, keeping the three newest so they stay within the free storage:

```sh
gcloud artifacts repositories create lokki --repository-format=docker --location=$REGION
cat > /tmp/cleanup.json <<'EOF'
[
  {"name": "keep-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 3}},
  {"name": "delete-the-rest", "action": {"type": "Delete"}, "condition": {"tagState": "any"}}
]
EOF
gcloud artifacts repositories set-cleanup-policies lokki --location=$REGION --policy=/tmp/cleanup.json
```

## 2. Service accounts

One the server runs as, and one that GitHub Actions deploys with:

```sh
gcloud iam service-accounts create lokki-server --display-name="Lokki sync server"
gcloud iam service-accounts create lokki-deploy --display-name="Deploys Lokki from GitHub"
SERVER=lokki-server@$PROJECT.iam.gserviceaccount.com
DEPLOY=lokki-deploy@$PROJECT.iam.gserviceaccount.com

# Deploying: Cloud Run services (run.admin, as the services are open to everyone), running them as lokki-server,
# and pushing images
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$DEPLOY --role=roles/run.admin
gcloud iam service-accounts add-iam-policy-binding $SERVER --member=serviceAccount:$DEPLOY \
  --role=roles/iam.serviceAccountUser
gcloud artifacts repositories add-iam-policy-binding lokki --location=$REGION \
  --member=serviceAccount:$DEPLOY --role=roles/artifactregistry.writer
```

GitHub Actions may act as `lokki-deploy` only from this repository's `main` branch:

```sh
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc lokki --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository == 'joakimnordling/lokki' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding $DEPLOY --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/joakimnordling/lokki"
```

## 3. The database

**PostgreSQL** (e.g. a free one from Aiven): store its URL as a secret the server may read. A plain `postgres://` URL
with `sslmode=require` works as the service gives it.

```sh
printf %s 'postgres://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require' | \
  gcloud secrets create lokki-database-url --data-file=- --replication-policy=user-managed --locations=$REGION
gcloud secrets add-iam-policy-binding lokki-database-url --member=serviceAccount:$SERVER \
  --role=roles/secretmanager.secretAccessor
```

**Firestore**: the free quota covers one database per project, the `(default)` one.

```sh
gcloud firestore databases create --location=$REGION
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SERVER --role=roles/datastore.user
```

## 4. GitHub

One [environment](https://docs.github.com/actions/deployment/targeting-different-environments) per server, e.g.
`sync1` and `sync2`, each with these variables (Settings → Environments). None of them are secret.

| Variable                         | Example                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `GCP_PROJECT_ID`                 | `your-project`                                                                             |
| `GCP_REGION`                     | `europe-north1`                                                                            |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/lokki`         |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | `lokki-deploy@your-project.iam.gserviceaccount.com`                                        |
| `GCP_RUNTIME_SERVICE_ACCOUNT`    | `lokki-server@your-project.iam.gserviceaccount.com`                                        |
| `CLOUD_RUN_SERVICE`              | `lokki-sync1`                                                                              |
| `LOKKI_PUBLIC_URL`               | `https://lokki-sync1-123456789.europe-north1.run.app`, or your own domain once it's set up |
| `LOKKI_CORS_ORIGINS`             | `["https://lokki.example.com"]`: where the app is served from                              |
| `LOKKI_DATABASE_SECRET`          | `lokki-database-url`, for PostgreSQL                                                       |
| `LOKKI_DATABASE_URL`             | `firestore://your-project`, for Firestore (instead of the secret)                          |
| `CLOUD_RUN_MEMORY`               | optional, default `256Mi`                                                                  |

Cloud Run addresses are known in advance: `https://SERVICE-PROJECT_NUMBER.REGION.run.app`.

Then the repository variable that turns deploying on (Settings → Secrets and variables → Actions → Variables):
`DEPLOY_ENVIRONMENTS` = `["sync1"]`, or `["sync1", "sync2"]`. Run the workflow from the Actions tab, or merge a
change to the server.

## 5. Vaults and tokens

The command line works from your own machine, directly on the same database. Nothing on the server needs to be open for
it, and new tokens appear only on your screen, never in Cloud Run's logs. From `servers/python`:

```sh
# PostgreSQL: the same URL as in the secret
export LOKKI_DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require'
# Firestore: sign in once with your Google account
#   gcloud auth application-default login
#   export LOKKI_DATABASE_URL=firestore://YOUR-PROJECT-ID
export LOKKI_PUBLIC_URL=https://lokki-sync1-123456789.europe-north1.run.app   # printed with each token

uv run lokki-server migrate        # PostgreSQL only, if the server hasn't started yet: creates the tables
uv run lokki-server vault add jocke
uv run lokki-server token add jocke "iPhone 17 Pro"
```

Enter the URL and token in the app: Preferences → Sync.

## A domain of your own

Cloud Run can map a domain such as `sync1.example.com` to a service, where the region supports it:

```sh
gcloud beta run domain-mappings create --service=lokki-sync1 --domain=sync1.example.com --region=$REGION
```

It prints the DNS records to add. Then set `LOKKI_PUBLIC_URL` to the new address and deploy again. Devices that synced
through the old address keep working: they recognise the server by its ID, so changing the URL in the app is enough.
