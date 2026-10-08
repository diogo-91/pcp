import { crc32 } from "node:zlib";

/** Gera um .xlsx mínimo (zip sem compressão) para testar o leitor: texto vai em sharedStrings, como o Excel faz. */
export type ValorCelula = string | number | { erro: string };
export type Folha = Record<number, Record<string, ValorCelula>>;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function zip(arquivos: Record<string, string>): Buffer {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let deslocamento = 0;

  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const nomeBuf = Buffer.from(nome, "utf8");
    const dados = Buffer.from(conteudo, "utf8");
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    partes.push(local, nomeBuf, dados);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(dados.length, 20);
    c.writeUInt32LE(dados.length, 24);
    c.writeUInt16LE(nomeBuf.length, 28);
    c.writeUInt32LE(deslocamento, 42);
    central.push(c, nomeBuf);

    deslocamento += 30 + nomeBuf.length + dados.length;
  }

  const dirCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(Object.keys(arquivos).length, 8);
  fim.writeUInt16LE(Object.keys(arquivos).length, 10);
  fim.writeUInt32LE(dirCentral.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...partes, dirCentral, fim]);
}

export function montarXlsx(folhas: Record<string, Folha>): Buffer {
  const strings: string[] = [];
  const indice = (t: string) => {
    let i = strings.indexOf(t);
    if (i < 0) i = strings.push(t) - 1;
    return i;
  };

  const nomes = Object.keys(folhas);
  const arquivos: Record<string, string> = {};

  nomes.forEach((nome, n) => {
    const linhas = Object.entries(folhas[nome])
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([linha, colunas]) => {
        const celulas = Object.entries(colunas).map(([col, v]) => {
          if (typeof v === "number") return `<c r="${col}${linha}"><v>${v}</v></c>`;
          if (typeof v === "string") return `<c r="${col}${linha}" t="s"><v>${indice(v)}</v></c>`;
          return `<c r="${col}${linha}" t="e"><v>${xml(v.erro)}</v></c>`;
        });
        return `<row r="${linha}">${celulas.join("")}</row>`;
      });
    arquivos[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas.join("")}</sheetData></worksheet>`;
  });

  arquivos["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nomes
    .map((nome, n) => `<sheet name="${xml(nome)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`)
    .join("")}</sheets></workbook>`;
  arquivos["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nomes
    .map((_, n) => `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`)
    .join("")}</Relationships>`;
  arquivos["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join("")}</sst>`;
  arquivos["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;

  return zip(arquivos);
}
