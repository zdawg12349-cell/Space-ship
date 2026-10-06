export async function startApp(canvas: HTMLCanvasElement): Promise<void> {
  const { runViewer } = await import('../debug/viewer');
  await runViewer(canvas);
}
