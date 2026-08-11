type RendererTarget = {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string, ...args: unknown[]) => void;
  };
};

export function sendToRenderer(target: RendererTarget | undefined, channel: string, ...args: unknown[]) {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(channel, ...args);
  return true;
}
