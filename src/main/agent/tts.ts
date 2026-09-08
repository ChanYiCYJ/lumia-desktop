/**
 * 本地 TTS：Microsoft Edge Read Aloud API（msedge-tts，MIT）
 * 桌面端替代 FastAPI /api/v1/tts —— 主进程合成，无需后端。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

/** 常用中文音色（与 lumia chatSettings TTS_VOICES 对齐） */
export const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女·活泼）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男·浑厚）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（男·新闻）' }
] as const

export interface TtsResult {
  ok: boolean
  audio?: Buffer
  contentType?: string
  error?: string
}

/** 合成语音并返回音频 buffer（WEBM/OPUS，lip-sync 解码兼容） */
export async function synthesize(text: string, voice?: string): Promise<TtsResult> {
  const cleaned = String(text || '').slice(0, 600)
  if (!cleaned) return { ok: false, error: 'empty text' }
  try {
    const tts = new MsEdgeTTS()
    await tts.setMetadata(
      voice || 'zh-CN-XiaoxiaoNeural',
      OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS
    )
    const { audioStream } = tts.toStream(cleaned)
    const chunks: Buffer[] = []
    for await (const chunk of audioStream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return { ok: true, audio: Buffer.concat(chunks), contentType: 'audio/webm' }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}
