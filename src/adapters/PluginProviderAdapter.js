export class PluginProviderAdapter {
  constructor({ id, logger = console }) {
    this.id = id;
    this.logger = logger;
  }

  async getManifest() {
    throw new Error(`${this.id} adapter does not implement getManifest()`);
  }

  async getStreams() {
    throw new Error(`${this.id} adapter does not implement getStreams()`);
  }
}

