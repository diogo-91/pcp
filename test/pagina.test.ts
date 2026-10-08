import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { paginaInicial } from "../src/pagina";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";

const HTML = '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>';

function pastaComTela(conteudos: { css?: string; appCss?: string; js?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tela-"));
  writeFileSync(join(dir, "index.html"), HTML);
  writeFileSync(join(dir, "style.css"), conteudos.css ?? "a{}");
  writeFileSync(join(dir, "app.css"), conteudos.appCss ?? "b{}");
  writeFileSync(join(dir, "app.js"), conteudos.js ?? "console.log(1)");
  return dir;
}

const versoes = (html: string) => Object.fromEntries([...html.matchAll(/"\/([\w.]+)\?v=([0-9a-f]{10})"/g)].map((m) => [m[1], m[2]]));

test("cada arquivo da tela é pedido com um código de versão de 10 caracteres", () => {
  const dir = pastaComTela();
  try {
    const v = versoes(paginaInicial(dir));
    assert.deepEqual(Object.keys(v).sort(), ["app.css", "app.js", "style.css"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("o código muda quando o CONTEÚDO do arquivo muda, e só o dele", () => {
  const dir = pastaComTela();
  try {
    const antes = versoes(paginaInicial(dir));
    assert.deepEqual(versoes(paginaInicial(dir)), antes, "sem mudança, o código é o mesmo");

    writeFileSync(join(dir, "app.js"), "console.log(2) // nova versão");
    const depois = versoes(paginaInicial(dir));
    assert.notEqual(depois["app.js"], antes["app.js"], "app.js mudou → código novo (o navegador não reaproveita o velho)");
    assert.equal(depois["app.css"], antes["app.css"]);
    assert.equal(depois["style.css"], antes["style.css"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function montarApp() {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  return buildApp({ repo, sync, accessToken: "segredo-123" });
}

test("GET / e /index.html servem a tela versionada, sem cache e SEM exigir o código de acesso (a senha é só da API)", async () => {
  const app = await montarApp();
  for (const url of ["/", "/index.html"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 200, url);
    assert.match(String(r.headers["content-type"]), /text\/html/);
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.deepEqual(Object.keys(versoes(r.body)).sort(), ["app.css", "app.js", "programacao.css", "programacao.js", "style.css"], url);
  }
});

test("os arquivos versionados continuam sendo servidos (a query ?v= é ignorada) e a API não foi afetada", async () => {
  const app = await montarApp();
  const html = (await app.inject({ method: "GET", url: "/" })).body;
  const v = versoes(html);

  const js = await app.inject({ method: "GET", url: `/app.js?v=${v["app.js"]}` });
  assert.equal(js.statusCode, 200);
  assert.match(js.body, /api\/pedidos/);
  assert.equal((await app.inject({ method: "GET", url: `/app.css?v=${v["app.css"]}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/style.css?v=${v["style.css"]}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/programacao.js?v=${v["programacao.js"]}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/programacao.css?v=${v["programacao.css"]}` })).statusCode, 200);

  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos" })).statusCode, 401, "a API segue protegida");
  assert.equal((await app.inject({ method: "GET", url: "/nao-existe.js" })).statusCode, 404);
});
