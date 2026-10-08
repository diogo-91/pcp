# GFERRO · PCP & Entrega

Tabela de acompanhamento de pedidos do PCP. Projeto **independente** do MES.

- A **Nomus** entrega só quatro dados dos pedidos com status **Liberado**: nome do cliente, número do pedido, telefone e prazo de entrega.
- Todo o resto (status do PCP, atendimento, responsável, plano de ação) é preenchido **manualmente** na tela. O **prazo de entrega também é editável**: nasce com o valor da Nomus e depois é do PCP.
- Tudo é gravado em um **banco SQLite**; a tela apenas exibe o que o servidor entrega (os alertas de prazo já saem calculados do servidor).

## Rodar localmente

Requer Node 22.13 ou superior.

```
npm install
cp .env.example .env      # preencha NOMUS_TOKEN
npm run dev
```

Abra http://localhost:3100. A primeira sincronização começa 3 s após subir e leva alguns minutos (rate limit da Nomus).
Para fazer só a carga inicial e sair: `npm run sync`.

Testes e tipos: `npm test` e `npm run typecheck`.

## Como a sincronização funciona

A Nomus guarda a situação **por item** do pedido, em `itensPedido[].status` (1 = Aguardando liberação, 2 = **Liberado**).
O sincronizador pede à Nomus só os pedidos com item nesse status (`/pedidos?query=itensPedido.status=2`), sem varrer o histórico, e lê página a página (50 por vez).

**Regra central: a sincronização só INCLUI pedidos novos.** Um pedido que já está no banco nunca é atualizado nem removido por ela, então prazo, status, atendimento, responsável e plano de ação editados no PCP nunca são desfeitos.

- Cada página é gravada assim que chega: a tabela enche aos poucos e uma falha no meio não perde o que já entrou.
- Nome e telefone vêm do cadastro do cliente (`/pessoas`), consultado só para pedidos novos (e guardado em cache por 7 dias).
- Se o cliente de um pedido novo não puder ser consultado (limite da Nomus), o pedido **não entra em branco**: fica de fora e entra na próxima rodada.
- Prazo inicial = data de entrega mais próxima entre os itens liberados **+ `ENTREGA_DIAS_EXTRA` dias (padrão: 20)**, uma margem de produção. Só vale na **entrada** do pedido: quem já está no banco nunca muda, e sincronizar de novo não soma outra vez. Pedido sem data de entrega na Nomus continua sem prazo. `ENTREGA_DIAS_EXTRA=0` usa o prazo da Nomus como veio.
- O pedido só sai da tabela quando o PCP o marca como **ENCERRADO** ou **CANCELADO** (continua no banco). Consequência da regra acima: um pedido que já saiu de "Liberado" na Nomus (faturado, cancelado lá) continua na tabela até alguém encerrá-lo aqui.
- Campos de data só gravam depois que a pessoa para de digitar; limpar uma data é pelo botão "×".

Se o código do status mudar, ajuste `NOMUS_STATUS_LIBERADO`. Uma varredura leva 10 a 15 min (limite de consultas da Nomus) e o padrão é rodar a cada 1 h; o botão "Sincronizar" força uma rodada.

## Usando a tela

- **Dashboard → tabela:** clicar em qualquer pedido do dashboard (fila prioritária ou listas por prazo) abre esse pedido na tabela: limpa filtros que o escondam, rola até a linha e a destaca por alguns segundos.
- **Finalizar um pedido:** marque o status como **ENCERRADO** (ou **CANCELADO**). Ele sai da tabela, mas **continua gravado no banco**. Um aviso com **Desfazer** fica por 12 segundos para o caso de engano; depois disso, só pela API/banco (`GET /api/pedidos?finalizados=1` lista os finalizados).
- **Pedido muito atrasado some do painel:** um pedido não finalizado com mais de `JANELA_OCULTAR_ATRASO_DIAS` (padrão: **90**) dias corridos de atraso fica oculto por padrão, no dashboard e na tabela — em geral é pedido antigo represado, não uma prioridade do dia a dia. Continua gravado e contado; a barra superior mostra "N pedido(s) c/ 90+ dias de atraso ocultos · Mostrar", e o botão alterna para trazê-los de volta (`GET /api/pedidos?antigos=1`). Um pedido ENCERRADO/CANCELADO nunca conta como "oculto" por este motivo — ele já sai da tela pelo status.

## Deploy no EasyPanel

O projeto tem `Dockerfile` na raiz; o EasyPanel constrói a imagem a partir do repositório no GitHub.

**1. Criar o serviço.** No projeto do EasyPanel: **+ Service → App**. Em **Source**, escolha **GitHub**, o repositório e a branch `main`. Em **Build**, **Dockerfile** (caminho `Dockerfile`).

**2. Variáveis de ambiente** (aba *Environment*):

| Variável | Valor |
|---|---|
| `NOMUS_BASE_URL` | `https://constelha.nomus.com.br/constelha/rest` |
| `NOMUS_TOKEN` | o mesmo token que o MES usa (copie do serviço do MES no EasyPanel) |
| `ACCESS_TOKEN` | um código de acesso à sua escolha, **8 caracteres ou mais** |

Em produção o servidor **não sobe sem `ACCESS_TOKEN`** (a tela mostra nomes e telefones de clientes). A tela pede esse código uma vez e o guarda no navegador. Outras variáveis (opcionais): ver `.env.example`.

**3. Volume persistente (obrigatório).** Na aba *Mounts*: **+ Volume**, caminho de montagem **`/app/data`**. Sem isso o banco, e tudo que o PCP digitou, some a cada redeploy.

**4. Domínio.** Na aba *Domains*, aponte para a **porta 3100** (o EasyPanel emite o HTTPS).

**5. Deploy** e conferência: nos logs deve aparecer `PCP & Entrega em http://localhost:3100`; abra o domínio, informe o `ACCESS_TOKEN` e clique em **Sincronizar**. A primeira leitura da Nomus leva de 10 a 15 minutos, e a tabela vai enchendo sozinha.

> O nome exato dos menus pode variar um pouco conforme a versão do EasyPanel.

**Depois de um deploy não precisa limpar o cache do navegador:** a página inicial (`/`) é montada pelo servidor e pede `style.css`, `app.css` e `app.js` com um código que muda quando o conteúdo muda (`/app.js?v=3f9a1c07b2`), e é servida com `Cache-Control: no-cache`. Assim o navegador nunca mistura um HTML novo com um `app.js` antigo (ver `src/pagina.ts`).

### Levar os dados que já foram preenchidos (uma vez)

O banco de produção nasce vazio. Para levar o que já foi digitado no banco local (status, prazos, atendimento...) e o histórico de pedidos antigos, gere um backup em JSON na máquina onde está o banco:

```
npm run exportar -- backup.json
```

Depois, no **Console** do serviço no EasyPanel, coloque o arquivo em `/tmp` e rode:

```
npm run importar -- /tmp/backup.json --atualizar
```

- `--atualizar`: pedidos que já existem (por exemplo, os que a sincronização já trouxe) recebem status, prazo, atendimento, responsável e plano de ação do arquivo. **Nome, telefone e código nunca são alterados.** Sem a flag, só entram pedidos que ainda não existem.
- **Não sobrescreve uma edição feita depois do backup:** se alguém já ajustou aquele pedido no sistema (na tela) depois do momento em que o arquivo foi gerado (`exportadoEm`), a importação pula esse pedido (conta em `puladosPorEdicaoRecente`) em vez de apagar um trabalho mais novo. Gere o backup **na hora da virada**, e verifique esse número no resultado: se vier maior que zero, confira manualmente se aqueles pedidos precisam do valor do arquivo mesmo assim.
- O arquivo é validado inteiro antes de gravar qualquer coisa, a importação é uma transação única e **nunca apaga nada**. Rodar de novo não muda nada.
- O JSON tem nomes e telefones de clientes: não o publique nem o guarde em lugar aberto. Apague-o depois.
- Refaça o `exportar` **na hora da virada**: qualquer alteração feita no banco local depois do backup não estará nele.

**Backup contínuo:** o banco é um arquivo só (`pcp.sqlite`) e está sempre completo: copiar esse arquivo, ou rodar `npm run exportar`, já é um backup válido.

## API

| Rota | O que faz |
|---|---|
| `GET /api/pedidos` | Pedidos da tabela, resumo por faixa de prazo, `ocultosMuitoAtrasados` (quantos somem por atraso de 90+ dias), opções dos selects e estado da sincronização. `?finalizados=1` inclui encerrados/cancelados; `?antigos=1` inclui os muito atrasados. |
| `PATCH /api/pedidos/:id` | Grava campos editáveis: `prazoEntrega`, `statusPcp`, `atendimento`, `responsavel`, `acao`, `prazoAcao`, `acaoStatus`. Datas AAAA-MM-DD entre 2000 e 2100 (vazio limpa). Número do pedido, cliente e telefone são recusados. |
| `GET /api/programacao` | **Programação de produção**: itens já calculados (status de prazo, pronta entrega, alertas), totais, indicadores e opções. Filtros: `visao`, `situacao`, `statusPrazo`, `rota`, `produto`, `tipo`, `cor`, `campoData`+`de`+`ate`, `soAlertas=1`, `q`. |
| `GET /api/programacao/exportar.csv` | Mesma visão filtrada em CSV (`;`, UTF-8 com BOM). |
| `GET /api/programacao/pedidos/:id` | Detalhe: pedido, itens, OPs, consumos e histórico de alterações. |
| `PATCH /api/programacao/itens/:id`, `PATCH /api/programacao/pedidos/:id`, `POST /api/programacao/lote` | Edição de campos do PCP (item, pedido, em massa). Validam datas e cronologia; gravam evento com o autor (`x-pcp-usuario`). |
| `PUT /api/programacao/itens/:id/consumos` | Lança consumo manual (parafusos, componentes). |
| `GET/PATCH /api/programacao/parametros`, `GET/PATCH /api/programacao/produtos`, `PUT /api/programacao/cidades-rota` | Configurações: parâmetros de cálculo, de-para produto → categoria, cidade → rota. |
| `POST /api/programacao/pedidos/:id/sincronizar` | Busca esse pedido na Nomus agora. |
| `POST /api/programacao/importar?gravar=0\|1` | Importa a planilha (corpo = o `.xlsx`). `gravar=0` só simula. |
| `POST /api/sync` | Dispara a sincronização em segundo plano (202). |
| `GET /api/sync` | Estado e histórico da última sincronização. |
| `GET /api/publico/pedido?pedido=917` | **Consulta pública** (site dos clientes). Sem autenticação. Devolve só `{ success, pedido, status, prazo }`. Ver a seção abaixo. |
| `GET /api/health` | Health check (sem autenticação). |

Com `ACCESS_TOKEN`, as rotas `/api/*` (exceto health) exigem o header `x-pcp-token`.

## Programação de produção (menu "Programação")

Substitui a aba **Base** da planilha "Programação de Produção 2026". Um item de pedido por linha, agrupável por pedido.

**De onde vem cada dado.** Os dados comerciais vêm da Nomus na **mesma varredura** de pedidos liberados que o PCP já faz (nenhuma chamada extra de pedido): pedido, data do pedido, valor, cliente, telefone, cidade/UF (cadastro do cliente), produto (`/produtos`), medidas e cor (texto livre do item) e as OPs (`/ordens`, em lotes). Situação, datas de programação/liberação/produção/entrega, prazo negociado, observação e rota são **do PCP**: a sincronização só escreve as colunas da Nomus e **nunca** sobrescreve o que foi editado. Consumos (bobina, EPS, cola, tinta) são **calculados** dos parâmetros em *Configurações*; parafusos e componentes são lançados na gaveta do pedido.

**Regras corrigidas em relação à planilha** (todas calculadas no servidor, em `src/programacao/regras.ts`): item entregue nunca é "atrasado"; sem prazo é "sem data"; pronta entrega exige data produzida; valor do pedido é somado **uma vez por pedido**; cancelado/devolução ficam fora dos totais; situação é uma lista fechada (as 21 grafias da planilha caem nela); a cronologia liberação ≤ produzida ≤ entrega é validada; `PRODUZIDO` exige a data produzida e `ENTREGUE` assume hoje.

**Para quem é o quê.** `ACCESS_TOKEN` dá acesso completo. Com `ACCESS_TOKEN_CONSULTA` (outro código) cria-se um perfil **somente leitura**: vê a Programação sem telefones de clientes, não edita e não acessa o resto da API. Quem edita é identificado pelo nome que a tela pede na primeira edição (vai para o histórico).

**O que muda numa nova sincronização.** Item já programado cujo texto mudou na Nomus ganha o alerta "alterado no ERP após programação"; item que some do pedido é marcado "removido no ERP" (não é apagado); rodar a sincronização duas vezes não altera nada.

### Outras abas da Programação

- **Agenda** (substitui a "CRP – Carga Máquina"): um dia útil por coluna, com os itens programados, metros, metros pintados, EPS, valor, barra de ocupação contra a capacidade (verde até 80%, amarela até 100%, vermelha acima) e carga livre. Arraste um item para outro dia (atualiza "Programado para"); a lista lateral traz os itens liberados sem data e os de programação vencida. Feriados (botão **Feriados**) e fins de semana não contam como dia de trabalho. Mede-se a ocupação em **metros de telha** (soma das medidas).
- **Painel**: (1) em aberto por situação, (2) em aberto por rota (com os pedidos de cada uma) e (3) produção x vendas por mês, com média por dia útil e % entregue no prazo. Produzido = pela data produzida; vendido = pela data do pedido na Nomus.
- **Compras de terceiros** (substitui ANFER, PVC e Translúcida/PIR): lista única por tipo (forro Anfer, trapézio Anfer, forro PVC, translúcida, PIR), vinculada ao pedido pelo número. Valor do forro Anfer = metros × `preco_forro_anfer_m` (R$ 50), ou valor digitado. Forro PVC mostra peças = metros ÷ (comprimento da peça × 0,20). Por fornecedor: total comprado (só Comprado/Recebido/Retirado), pago (lançamentos com data) e saldo. Fornecedores iniciais: Anfer, Açoluma, Fenix, Drafer, Sorotelha, Torre Steel, IBI Metal.
- **Parafusos**: 13 tipos; consumo médio dos 6 últimos meses fechados (pelos itens produzidos), demanda dos pedidos em aberto, estoque contado pela equipe e **comprar = demanda + 2 × média − estoque** (mínimo 0). As quantidades por pedido são lançadas na gaveta do pedido (a Nomus não traz parafuso como item nos pedidos lidos até agora).
- **Calculadora de bobina**: peso ↔ comprimento (espessura, largura, densidade 7.850).

### Importar o histórico da planilha (uma vez)

Datas de liberação/produção/entrega, situação, prazo negociado e observações só existem na planilha. Em *Programação → Configurações → Importar histórico da planilha*, escolha o `.xlsx` (abas **Base** e **Rotas**) e clique em **Simular**: nada é gravado e você baixa o relatório CSV (importadas, ajustadas, rejeitadas, com o motivo e a linha da planilha). Depois **Gravar importação** (o banco é copiado antes para `backups-operacoes/`). Datas em texto ("xxx", "22/01 e 23/01") ou de antes de 2025 são rejeitadas; itens editados no sistema depois da carga são preservados. Pelo terminal: `npm run importar-planilha -- "arquivo.xlsx" [--gravar] [--forcar]`.

### Perguntas em aberto (valem como parâmetro até a resposta)

1. **Sanduíche**: "faces de pintura = 2" são as duas chapas pintadas por fora ou as duas faces de uma chapa? "Metros de chapa" é sempre o dobro do metro de telha? (parâmetro `fator_chapa_sanduiche` = 2; a tinta usa `faces` do produto.)
2. **Capacidade** (`capacidade_m_dia` = 2000): é por máquina, turno ou da fábrica? O ritmo medido foi de 950 a 1.230 m por dia útil.
3. **Bobina** (`bobina_kg_por_metro` = 3,6): corresponde a qual espessura? Deveria variar por item?
4. **Valor a receber**: hoje é o **valor total do pedido** (`valorTotal` da Nomus). Se a intenção é o saldo financeiro em aberto, falta a fonte (contas a receber).
5. **Liberação da produção**: a Nomus informa o **status da OP** (Confirmada, Liberada, Encerrada), mas não a data; por isso `data_liberacao_producao` segue sendo do PCP.
6. **Cancelado/entregue na Nomus**: o pedido da Nomus não traz um campo de cancelamento e a varredura só lê itens liberados. Informe o código de status de item que significa "cancelado" em `NOMUS_STATUS_CANCELADO` para a automação (item vira `CANCELADO`, com evento de origem "sync").

## Prazo de produção (programação do Planejamento)

A coluna **Prazo de produção** (ao lado do prazo de entrega) mostra a data em que as ordens do pedido estão agendadas no **Planejamento** do sistema de apontamento (o calendário onde o PCP arrasta as ordens para o dia de produzir).

- **Fonte:** `GET /api/planejamento` do sistema de apontamento (`PLANEJAMENTO_URL`, ex.: `https://apontamento.seudominio.com`). Cada item do calendário traz o `idPedido` da Nomus, que é o `nomusId` da tabela daqui; se o id não casar, tenta pelo número do pedido (`PD 01279` → 1279).
- **Somente leitura:** nada é escrito no Planejamento, e a célula não é editável aqui. Para mudar a data, arraste a ordem no calendário do apontamento.
- **Várias ordens no mesmo pedido:** vale a data **mais tardia** (quando a produção termina de ser programada); ao passar o mouse na célula aparece cada ordem com o seu dia.
- **Aviso ⚠ em vermelho:** a produção está programada para **depois** do prazo de entrega (no mesmo dia não conta).
- **"Não programado":** nenhuma ordem do pedido está no calendário. Se a ordem for tirada do calendário, o pedido volta a "Não programado" na leitura seguinte.
- **Atualização:** a cada 10 min (`PLANEJAMENTO_INTERVAL_MS`) e quando alguém clica em **Sincronizar**. O rodapé da tabela informa quando foi a última leitura.
- **Falha não apaga nada:** se o apontamento estiver fora do ar, responder lixo ou devolver a lista **vazia** de repente (ele sobe vazio se o arquivo do planejamento estiver ilegível), a tela mantém a última programação lida e avisa no rodapé.
- **Fica separado do resto:** a leitura só escreve nas colunas `prazo_producao` e `producao_itens`; nunca altera dados da Nomus nem o que o PCP digitou, e não conta como edição manual.
- Sem `PLANEJAMENTO_URL` o recurso fica desligado e a coluna mostra "Não programado".

## Consulta pública (site dos clientes)

O site da Gferro consulta o andamento de um pedido por `GET /api/publico/pedido?pedido=917`. A rota responde **no mesmo formato** que o Google Apps Script devolvia, então o site só precisa apontar a `ORDER_API_URL` para ela:

```json
{ "success": true, "pedido": "917", "status": "ENCERRADO", "prazo": "28/08/2026" }
{ "success": false, "message": "Confira o número do pedido informado." }
```

- **Só expõe número, status e prazo.** Nunca nome, telefone, atendimento ou qualquer dado interno (há testes que garantem isso).
- **Sem senha:** a rota fica fora do `ACCESS_TOKEN`, então o site funciona mesmo com a tela do PCP protegida.
- **Busca só pelos dígitos:** `1978`, `01978` e `PD 01978` são o mesmo pedido.
- **Prazo e status** são os da tabela do PCP, inclusive o que foi ajustado na tela.
- **Pedidos antigos** (já entregues, que não estão mais na tabela) respondem a partir do **histórico**, importado da planilha. A tabela do PCP tem prioridade sobre o histórico.
- **Limite de consultas:** 60 por minuto por visitante (`429` acima disso). Como os números de pedido são sequenciais, isso impede varrer todos rapidamente. O IP do visitante é o que o proxy do EasyPanel anota (`TRUST_PROXY_HOPS`, padrão 1 em produção); o cabeçalho `X-Forwarded-For` escrito pelo próprio visitante é ignorado, então não dá para burlar o limite inventando IPs. Se colocar outro serviço na frente (ex.: Cloudflare), use `TRUST_PROXY_HOPS=2`.
- **CORS:** por padrão qualquer site pode chamar (o dado é público e sem credenciais). Para restringir, defina `PUBLIC_ORIGINS` com os sites autorizados, separados por vírgula.
- Erros lógicos (não encontrado, número inválido) voltam com HTTP 200 e `success: false`, como no script antigo.

**Atenção:** a planilha deixa de ser a fonte do site. Status e prazos devem ser atualizados no PCP.

## Estrutura

```
src/          servidor (Fastify), Nomus, sincronização, banco
public/       tela (HTML/CSS/JS puro, sem build). style.css é o CSS original do PCP.
test/         testes (node:test)
```

O schema do banco evolui por migrações em `src/db.ts`: para mudar, **acrescente** um item ao final da lista, nunca edite os antigos.
