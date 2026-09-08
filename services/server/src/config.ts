export interface ServerConfig {
  port: number;
  /** Orchestrator public URL (offchain lab) or gateway URL. */
  orchestratorUrl: string;
  /** When set, bypass the orchestrator and call runners directly (dev). */
  perceiveUrl?: string;
  decideUrl?: string;
  /** Where VOD sources + clips live. */
  dataDir: string;
  ffmpegPath: string;
  gameHintDefault: string;
  clipBeforeS: number;
  clipAfterS: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    decideUrl: env.DECIDE_URL,
    dataDir: env.DATA_DIR ?? "data",
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    gameHintDefault: env.GAME_HINT ?? "unspecified",
    clipBeforeS: Number(env.CLIP_BEFORE_S ?? 4),
    clipAfterS: Number(env.CLIP_AFTER_S ?? 4),
  };
}
