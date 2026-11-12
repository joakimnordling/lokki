"""Makes the spreadsheets the import tests read: made-up logs, written by openpyxl and re-saved by LibreOffice.

    python3 tests/fixtures/sheets/make.py     (needs openpyxl, and LibreOffice's soffice on the PATH)
"""

import datetime as dt
import pathlib
import shutil
import subprocess
import tempfile

from openpyxl import Workbook
from openpyxl.utils.datetime import CALENDAR_MAC_1904

here = pathlib.Path(__file__).parent


def workbook(epoch1904=False):
    wb = Workbook()
    if epoch1904:
        wb.epoch = CALENDAR_MAC_1904
    log = wb.active
    log.title = "Log"
    log.append(["Date", "Time", "Weight", "Steps", "Note"])
    rows = [
        (dt.date(2026, 11, 2), dt.time(7, 30), 79.4, 8500, "windy"),
        (dt.date(2026, 11, 3), dt.time(7, 45), 79.1, None, None),
        (dt.date(2026, 11, 4), dt.time(20, 5), 78.9, 10200, "long walk"),
    ]
    for r in rows:
        log.append(r)
    for row in log.iter_rows(min_row=2):
        row[0].number_format = "d.m.yyyy"
        row[1].number_format = "h:mm"
    moods = wb.create_sheet("Moods")
    moods.append(["When", "Mood"])
    moods.append([dt.datetime(2026, 11, 2, 21, 15), 7])
    moods.append([dt.datetime(2026, 11, 3, 22, 0), 6])
    for row in moods.iter_rows(min_row=2):
        row[0].number_format = "yyyy-mm-dd hh:mm"
    notes = wb.create_sheet("Notes")
    notes.append(["Just some text", "about the logs"])
    return wb


def main():
    workbook().save(here / "openpyxl.xlsx")
    workbook(epoch1904=True).save(here / "mac1904.xlsx")
    with tempfile.TemporaryDirectory() as tmp:
        for fmt, name in [("ods", "libreoffice.ods"), ("xlsx:Calc MS Excel 2007 XML", "libreoffice.xlsx")]:
            out = pathlib.Path(tmp) / fmt.split(":")[0]
            subprocess.run(
                ["soffice", "--headless", "--convert-to", fmt, "--outdir", str(out), str(here / "openpyxl.xlsx")],
                check=True,
                capture_output=True,
            )
            shutil.copy(next(out.iterdir()), here / name)


if __name__ == "__main__":
    main()
