import ExcelJS from "exceljs";
import type {
  LegacySnapshotExporter,
  LegacySnapshotExportInput,
} from "../../application/ports/LegacySnapshotExporter";
import type { ExportedFile } from "../../application/ports/StockResultExporter";

const DATA_HEADERS = ["Artikelnummer", "Omschrijving", "Productgamma", "Hoeveelheid (historisch)", "Kostprijs (historisch)", "Waarde (historisch)"];

/**
 * Exporteert één historische snapshot als los Excelbestand: enkel de
 * ORIGINELE historische hoeveelheid en kostprijs van die periode (nooit de
 * actuele kostprijs), plus een INFO-blad dat de gekozen periode benoemt.
 * Bewust géén rollend archief (geen HISTORIE/ARTIKEL/CONFIG-sheets): een
 * legacy snapshot blijft immutable en wordt hier enkel geserialiseerd.
 */
export class ExcelLegacySnapshotExporter implements LegacySnapshotExporter {
  async exportSnapshot({ officeName, view }: LegacySnapshotExportInput): Promise<ExportedFile> {
    const workbook = new ExcelJS.Workbook();
    const dataSheetName = `Snapshot ${view.periodLabel.replace(/\//g, "-")}`.slice(0, 31);

    const info = workbook.addWorksheet("INFO");
    info.addRows([
      ["Historische snapshot", view.periodLabel],
      ["Kantoor", officeName],
      ["Peildatum", view.isoDate],
      ["Totale voorraadwaarde (historisch)", view.totalStockValue],
      ["Aantal artikelen", view.articleCount],
      ["Artikelen met onbekende waarde", view.articlesWithUnknownValue],
      [],
      ["Opmerking", "Hoeveelheid en kostprijs zijn de originele historische waarden van deze periode (geen actuele kostprijs)."],
    ]);
    info.getColumn(1).width = 38;
    info.getColumn(2).width = 60;
    info.getCell("B4").numFmt = "#,##0.00";

    const sheet = workbook.addWorksheet(dataSheetName);
    sheet.addRow(DATA_HEADERS).font = { bold: true };
    for (const row of view.articles) {
      sheet.addRow([
        row.articleNumber,
        row.description,
        row.productCategory,
        row.quantity,
        row.costPrice,
        row.value,
      ]);
    }
    [16, 48, 24, 22, 22, 22].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(5).numFmt = "#,##0.00";
    sheet.getColumn(6).numFmt = "#,##0.00";
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const data = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
    const safeOffice = officeName.replace(/[\\/:*?"<>|]/g, "-");
    return {
      fileName: `${view.isoDate} - Historische snapshot ${safeOffice}.xlsx`,
      data,
    };
  }
}
