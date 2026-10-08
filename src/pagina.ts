import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Arquivos que o index.html carrega e que mudam a cada versão da tela. */
const ARQUIVOS_DA_TELA = ["style.css", "app.css", "app.js", "programacao.css", "programacao.js"];

/**
 * Devolve o index.html com cada arquivo da tela pedido por um endereço que muda quando o CONTEÚDO muda
 * (`/app.js?v=3f9a1c07b2`). Sem isso, depois de um deploy o navegador podia ficar com o app.js antigo junto de um
 * HTML novo (ex.: cabeçalho com 12 colunas e linhas montadas com 11) e a tabela aparecia desencontrada até alguém
 * forçar a atualização. Com o endereço versionado, o HTML sempre manda buscar exatamente a versão que combina com ele.
 */
export function paginaInicial(pastaPublica: string): string {
  let html = readFileSync(join(pastaPublica, "index.html"), "utf8");

  for (const nome of ARQUIVOS_DA_TELA) {
    if (!html.includes(`"/${nome}"`)) continue; // só versiona o que o HTML realmente pede
    const versao = createHash("sha1").update(readFileSync(join(pastaPublica, nome))).digest("hex").slice(0, 10);
    html = html.replaceAll(`"/${nome}"`, `"/${nome}?v=${versao}"`);
  }

  return html;
}
