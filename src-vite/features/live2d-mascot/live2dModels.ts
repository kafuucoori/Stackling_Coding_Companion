// live2dModels.ts —— 从 public/live2d/manifest.json 读取可选模型清单。
// 「添加模型」= 放进 public/live2d/<id>/ 并在 manifest.json 加一条，无需后端。

export interface Live2DModelEntry {
  id: string
  name: string
  entry: string
  thumbnail?: string
  layout?: Live2DModelLayout
}

export interface Live2DModelLayout {
  fit?: 'contain' | 'height' | 'width'
  scale?: number
  x?: number
  bottom?: number
  y?: number
  paddingX?: number
  paddingTop?: number
  paddingBottom?: number
}

interface Manifest {
  models: Live2DModelEntry[]
}

export const LIVE2D_BASE = '/live2d'

const MANIFEST_URL = `${LIVE2D_BASE}/manifest.json`

export function modelUrlOf(entry: Live2DModelEntry): string {
  return `${LIVE2D_BASE}/${entry.entry}`
}

export function thumbnailUrlOf(entry: Live2DModelEntry): string | undefined {
  return entry.thumbnail ? `${LIVE2D_BASE}/${entry.thumbnail}` : undefined
}

let cached: Promise<Live2DModelEntry[]> | null = null

export function loadLive2DModels(): Promise<Live2DModelEntry[]> {
  if (!cached) {
    cached = (async () => {
      const res = await fetch(MANIFEST_URL)
      if (!res.ok) {
        throw new Error(`manifest.json 加载失败: ${res.status}`)
      }
      const manifest = (await res.json()) as Manifest
      return Array.isArray(manifest.models) ? manifest.models : []
    })()
  }
  return cached
}

export const DEFAULT_MODEL_ID = 'moran-hanfu'
