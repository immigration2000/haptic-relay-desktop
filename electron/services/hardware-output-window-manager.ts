type ManagedWindow = {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  on(event: 'closed', listener: () => void): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
};

export class HardwareOutputWindowManager {
  private window: ManagedWindow | undefined;

  constructor(private readonly createWindow: () => ManagedWindow) {}

  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return this.window;
    }

    const window = this.createWindow();
    this.window = window;
    window.on('closed', () => {
      if (this.window === window) this.window = undefined;
    });
    return window;
  }

  send(channel: string, payload: unknown) {
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  }
}
