/**
 * Limite de consultas por visitante, numa janela fixa (ex.: 60 por minuto). Em memória: basta para uma instância só.
 * Existe porque os números de pedido são sequenciais: sem limite, alguém poderia varrer todos rapidamente.
 */
export class LimitadorPorJanela {
  private readonly janelas = new Map<string, { inicio: number; contagem: number }>();

  constructor(
    private readonly maximo: number,
    private readonly janelaMs: number,
    private readonly agora: () => number = Date.now
  ) {}

  /** True se a consulta pode seguir; false se este visitante estourou o limite na janela atual. */
  permitir(chave: string): boolean {
    const t = this.agora();
    this.limparVencidas(t);

    const atual = this.janelas.get(chave);
    if (!atual || t - atual.inicio >= this.janelaMs) {
      this.janelas.set(chave, { inicio: t, contagem: 1 });
      return true;
    }

    atual.contagem += 1;
    return atual.contagem <= this.maximo;
  }

  /** Evita que a tabela cresça sem parar com visitantes que nunca voltam. */
  private limparVencidas(t: number) {
    if (this.janelas.size < 5000) return;
    for (const [chave, janela] of this.janelas) {
      if (t - janela.inicio >= this.janelaMs) this.janelas.delete(chave);
    }
  }
}
