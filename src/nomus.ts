export interface NomusClientOptions {
  baseUrl: string;
  /** Credencial Basic já em base64 (o valor que vai depois de "Basic "). */
  token: string;
  timeoutMs?: number;
  /** Tentativas extras quando a Nomus responde 429 (rate limit) ou falha de rede/5xx. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class NomusHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "NomusHttpError";
  }
}

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** O 429 da Nomus vem como {"tempoAteLiberar":"4"} (segundos); qualquer outro corpo é ignorado. */
function lerTempoAteLiberar(corpo: string | undefined): unknown {
  try {
    return (JSON.parse(corpo || "{}") as { tempoAteLiberar?: unknown }).tempoAteLiberar;
  } catch {
    return undefined;
  }
}

/** Leitura da API REST da Nomus (somente GET). */
export class NomusClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opcoes: NomusClientOptions) {
    this.baseUrl = opcoes.baseUrl.replace(/\/$/, "");
    this.token = opcoes.token;
    this.timeoutMs = opcoes.timeoutMs ?? 30_000;
    this.maxRetries = opcoes.maxRetries ?? 10;
    this.fetchImpl = opcoes.fetchImpl ?? fetch;
    this.sleep = opcoes.sleep ?? esperar;
  }

  async get<T>(caminho: string): Promise<T> {
    if (!this.baseUrl) throw new Error("NOMUS_BASE_URL não configurada.");
    if (!this.token) throw new Error("NOMUS_TOKEN não configurado.");

    const url = `${this.baseUrl}${caminho.startsWith("/") ? caminho : `/${caminho}`}`;

    for (let tentativa = 0; ; tentativa++) {
      try {
        return await this.tentarUmaVez<T>(url, caminho);
      } catch (erro) {
        const espera = this.esperaAntesDeRepetir(erro);
        if (espera === null || tentativa >= this.maxRetries) throw erro;
        await this.sleep(espera);
      }
    }
  }

  /**
   * A Nomus pagina toda listagem em 50 registros (`?pagina=N`) sem informar o total:
   * percorre as páginas até vir uma incompleta. Filtros com join (ex.: `itensPedido.status=2`)
   * devolvem o mesmo pedido uma vez por item, então quem chama deve deduplicar por id.
   */
  async getAllPages<T>(caminho: string, opcoes: { pageSize?: number; pausaMs?: number } = {}): Promise<T[]> {
    const pageSize = opcoes.pageSize ?? 50;
    const pausaMs = opcoes.pausaMs ?? 1500;
    const separador = caminho.includes("?") ? "&" : "?";
    const itens: T[] = [];

    for (let pagina = 1; ; pagina++) {
      if (pagina > 1) await this.sleep(pausaMs);

      const lote = await this.get<T[]>(`${caminho}${separador}pagina=${pagina}`);
      if (!Array.isArray(lote)) {
        throw new NomusHttpError(`Resposta inesperada da Nomus em ${caminho} (página ${pagina}): não é uma lista.`);
      }

      itens.push(...lote);
      if (lote.length < pageSize) return itens;
    }
  }

  private async tentarUmaVez<T>(url: string, caminho: string): Promise<T> {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), this.timeoutMs);

    let resposta: Response;
    let corpo: string;
    try {
      resposta = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Basic ${this.token}` },
        signal: controle.signal,
      });
      corpo = await resposta.text();
    } catch (erro) {
      // Falha de rede ou timeout: vale repetir.
      throw new NomusHttpError(`Falha ao chamar a Nomus (${caminho}): ${String(erro)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!resposta.ok) {
      throw new NomusHttpError(`Nomus respondeu ${resposta.status} em ${caminho}`, resposta.status, corpo.slice(0, 500));
    }

    try {
      return JSON.parse(corpo) as T;
    } catch {
      throw new NomusHttpError(`Nomus devolveu um corpo que não é JSON em ${caminho}`, resposta.status, corpo.slice(0, 200));
    }
  }

  /** Quanto esperar antes de repetir, ou null se o erro não vale repetir. */
  private esperaAntesDeRepetir(erro: unknown): number | null {
    if (!(erro instanceof NomusHttpError)) return null;

    if (erro.status === 429) {
      const segundos = Number(lerTempoAteLiberar(erro.body));
      const base = Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : 3000;
      return Math.min(base + 1500, 30_000);
    }

    // Sem status = falha de rede/timeout; 5xx = instabilidade da Nomus.
    if (erro.status === undefined || erro.status >= 500) return 5000;

    return null;
  }
}
