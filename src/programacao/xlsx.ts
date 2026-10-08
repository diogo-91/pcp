import { inflateRawSync } from "node:zlib";

/**
 * Leitor mínimo de .xlsx (só leitura, sem dependências): lê as abas como texto/número exatamente como o Excel guardou
 * (valores já calculados das fórmulas). Serve à importação única da planilha de programação.
 */

export type Celula = string | number | boolean | null;
export type Aba = Map<number, Map<string, Celula>>; // linha -> coluna ("A", "BT"…) -> valor

interface EntradaZip {
  metodo: number;
  tamanhoComprimido: number;
  deslocamento: number;
}

function lerZip(buf: Buffer): Map<string, EntradaZip> {
  // O "end of central directory" fica nos últimos 22+ bytes (pode ter comentário depois).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Arquivo inválido: não é um .xlsx (zip) legível.");

  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = new Map<string, EntradaZip>();

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Arquivo inválido: diretório do zip corrompido.");
    const metodo = buf.readUInt16LE(p + 10);
    const tamanhoComprimido = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comentarioLen = buf.readUInt16LE(p + 32);
    const deslocamento = buf.readUInt32LE(p + 42);
    entradas.set(buf.toString("utf8", p + 46, p + 46 + nomeLen), { metodo, tamanhoComprimido, deslocamento });
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return entradas;
}

function extrair(buf: Buffer, e: EntradaZip): Buffer {
  const nomeLen = buf.readUInt16LE(e.deslocamento + 26);
  const extraLen = buf.readUInt16LE(e.deslocamento + 28);
  const ini = e.deslocamento + 30 + nomeLen + extraLen;
  const dados = buf.subarray(ini, ini + e.tamanhoComprimido);
  if (e.metodo === 0) return dados;
  if (e.metodo === 8) return inflateRawSync(dados);
  throw new Error(`Compressão não suportada no .xlsx (método ${e.metodo}).`);
}

const ENTIDADES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decodificar = (s: string) =>
  s
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTIDADES[m])
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

const textosDe = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodificar(m[1])).join("");

function lerStringsCompartilhadas(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textosDe(m[1]));
}

function lerAba(xml: string, strings: string[]): Aba {
  const aba: Aba = new Map();
  for (const linha of xml.matchAll(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numero = Number(linha[1]);
    const celulas = new Map<string, Celula>();
    for (const c of (linha[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1]);
      if (!ref) continue;
      const tipo = /\bt="(\w+)"/.exec(c[1])?.[1] ?? "n";
      const corpo = c[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];

      let valor: Celula = null;
      if (tipo === "s" && v !== undefined) valor = strings[Number(v)] ?? null;
      else if (tipo === "str" && v !== undefined) valor = decodificar(v);
      else if (tipo === "inlineStr") valor = textosDe(corpo);
      else if (tipo === "b" && v !== undefined) valor = v === "1";
      else if (tipo === "e") valor = null; // #REF!, #N/A…: erro de fórmula da planilha, sem valor aproveitável
      else if (v !== undefined && v !== "") valor = Number(v);

      if (valor !== null && valor !== "") celulas.set(ref[1], valor);
    }
    if (celulas.size > 0) aba.set(numero, celulas);
  }
  return aba;
}

export interface Planilha {
  abas: string[];
  aba(nome: string): Aba | null;
}

export function lerXlsx(buf: Buffer): Planilha {
  const zip = lerZip(buf);
  const ler = (nome: string) => {
    const e = zip.get(nome);
    return e ? extrair(buf, e).toString("utf8") : null;
  };

  const workbook = ler("xl/workbook.xml");
  const rels = ler("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("Arquivo inválido: não parece uma planilha do Excel (.xlsx).");

  const alvos = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[0])?.[1] ?? "", /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const folhas = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    nome: decodificar(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ""),
    rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "",
  }));

  const strings = lerStringsCompartilhadas(ler("xl/sharedStrings.xml") ?? "");
  const cache = new Map<string, Aba>();

  return {
    abas: folhas.map((f) => f.nome),
    aba(nome) {
      const f = folhas.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
      if (!f) return null;
      if (cache.has(f.nome)) return cache.get(f.nome) ?? null;
      const alvo = (alvos.get(f.rid) ?? "").replace(/^\/?(xl\/)?/, "xl/");
      const xml = ler(alvo);
      if (!xml) return null;
      const aba = lerAba(xml, strings);
      cache.set(f.nome, aba);
      return aba;
    },
  };
}

/** Número de série de data do Excel (dias desde 30/12/1899) -> AAAA-MM-DD. Fora de uma faixa razoável -> null. */
export function serialParaIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 36_526 || serial > 73_050) return null; // 2000..2099
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return d.toISOString().slice(0, 10);
}
