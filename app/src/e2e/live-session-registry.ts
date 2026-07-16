export class LiveSessionRegistry {
  private readonly sessionIds: string[] = [];

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum <= 0) throw new Error('Live session maximum must be positive');
  }

  get size() {
    return this.sessionIds.length;
  }

  async create<T extends { id: string }>(factory: () => Promise<T>) {
    this.assertCapacity();
    const session = await factory();
    this.register(session.id);
    return session;
  }

  register(sessionId: string) {
    if (this.sessionIds.includes(sessionId)) return;
    this.assertCapacity();
    this.sessionIds.push(sessionId);
  }

  async cleanup(removeAndVerify: (sessionId: string) => Promise<void>) {
    const failures: string[] = [];
    while (this.sessionIds.length > 0) {
      const sessionId = this.sessionIds.pop()!;
      try {
        await removeAndVerify(sessionId);
      } catch (error) {
        failures.push(`${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(`Live E2E cleanup failed: ${failures.join('; ')}`);
  }

  private assertCapacity() {
    if (this.sessionIds.length >= this.maximum) {
      throw new Error(`Live E2E session cap exceeded (${this.maximum})`);
    }
  }
}
