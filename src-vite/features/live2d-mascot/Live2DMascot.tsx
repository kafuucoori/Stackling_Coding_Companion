/**
 * Live2DMascot —— 折叠态看板娘（pixi-live2d-display + Pixi.js 7 / Cubism 4）。
 * 动画来自模型自带能力（物理/眨眼）+ 本组件的低频呼吸微摆 + petState 表情/徽标。
 * 前置：index.html 引入 live2dcubismcore.min.js，public/live2d/ 资源就位。
 */

import { useEffect, useRef, useState } from 'react'
import type { Live2DModelLayout } from './live2dModels'
import styles from './Live2DMascot.module.css'

export type MascotPetState = 'idle' | 'working' | 'compacting' | 'waiting' | 'chatting'

interface Live2DMascotProps {
  modelUrl?: string
  width?: number
  height?: number
  className?: string
  fallbackImage?: string
  petState?: MascotPetState
  stageScale?: number
  layout?: Live2DModelLayout
}

const DEFAULT_MODEL_URL = '/live2d/moran-hanfu/moran-hanfu.model3.json'
const DEFAULT_FALLBACK_IMAGE = '/live2d/moran-hanfu/icon.png'
const DEFAULT_W = 260
const DEFAULT_H = 520
const VIEWPORT_MODEL_SHIFT_Y = 24
const BADGE_SCALE_DAMPING = 0.6

const DEFAULT_LAYOUT: Required<Live2DModelLayout> = {
  fit: 'contain',
  scale: 1,
  x: 0,
  bottom: 20,
  y: 0,
  paddingX: 10,
  paddingTop: 8,
  paddingBottom: 20,
}

const BREATH_FREQ = 0.25
const SWAY_FREQ = 0.16

type Status = 'loading' | 'ready' | 'error'

const STATE_BADGE: Record<
  Exclude<MascotPetState, 'idle'>,
  { text: string; tone: string; toneDeep: string }
> = {
  working: { text: '工作中', tone: '#f7a8c6', toneDeep: '#ec6f9f' },
  compacting: { text: '整理中', tone: '#8be0ad', toneDeep: '#35bf73' },
  waiting: { text: '待处理', tone: '#8fc7ff', toneDeep: '#4f9df7' },
  chatting: { text: '对话中', tone: '#f5c2e7', toneDeep: '#d85fa7' },
}

const STATE_EXP: Record<MascotPetState, string | null> = {
  idle: null,
  working: 'exp5',
  compacting: 'exp6',
  waiting: 'exp3',
  chatting: 'exp5',
}
const ALL_EXP_PARAMS = ['exp5', 'exp6', 'exp3']

type Live2DCoreModel = {
  setParameterValueById: (id: string, value: number) => void
}

function coreModelOf(model: any): Live2DCoreModel {
  return model.internalModel.coreModel as Live2DCoreModel
}

export default function Live2DMascot({
  modelUrl = DEFAULT_MODEL_URL,
  width = DEFAULT_W,
  height = DEFAULT_H,
  className,
  fallbackImage = DEFAULT_FALLBACK_IMAGE,
  petState = 'idle',
  stageScale = 1,
  layout,
}: Live2DMascotProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<{ app: any; root: any; model: any }>({ app: null, root: null, model: null })
  const [status, setStatus] = useState<Status>('loading')
  const petStateRef = useRef<MascotPetState>(petState)
  petStateRef.current = petState

  const naturalBoundsRef = useRef<
    { x: number; y: number; width: number; height: number } | null
  >(null)

  const layoutRef = useRef<Required<Live2DModelLayout>>(DEFAULT_LAYOUT)
  layoutRef.current = { ...DEFAULT_LAYOUT, ...(layout ?? {}) }
  const stageScaleRef = useRef(stageScale)
  stageScaleRef.current = stageScale

  const measureNaturalBounds = (model: any) => {
    if (naturalBoundsRef.current) return naturalBoundsRef.current

    const sx = model.scale?.x ?? 1
    const sy = model.scale?.y ?? 1
    try {
      model.scale.set(1)
      const bounds = model.getLocalBounds()
      if (bounds.width > 0 && bounds.height > 0) {
        naturalBoundsRef.current = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }
      }
    } catch (err) {
      console.warn('[Live2D] bounds measure failed:', err)
    } finally {
      model.scale.set(sx, sy)
    }

    if (!naturalBoundsRef.current) {
      naturalBoundsRef.current = {
        x: 0,
        y: 0,
        width: model.width / (sx || 1),
        height: model.height / (sy || 1),
      }
    }
    return naturalBoundsRef.current
  }

  const fitModelInDesignStage = (model: any) => {
    const bounds = measureNaturalBounds(model)
    const l = layoutRef.current
    const targetW = Math.max(1, DEFAULT_W - l.paddingX * 2)
    const targetH = Math.max(1, DEFAULT_H - l.paddingTop - l.paddingBottom)
    const sx = targetW / bounds.width
    const sy = targetH / bounds.height
    const fitScale =
      l.fit === 'height' ? sy : l.fit === 'width' ? sx : Math.min(sx, sy)
    const scale = fitScale * l.scale
    if (model.anchor?.set) model.anchor.set(0, 0)
    if (model.pivot?.set) model.pivot.set(0, 0)
    model.scale.set(scale)
    model.x = l.paddingX + (targetW - bounds.width * scale) / 2 - bounds.x * scale + l.x
    model.y = l.paddingTop + (targetH - bounds.height * scale) / 2 - bounds.y * scale + l.y
  }

  const syncStageToCanvas = () => {
    const { root, model } = stateRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const s = stageScaleRef.current
    const w = DEFAULT_W * s
    const h = DEFAULT_H * s
    const app = stateRef.current.app
    if (app?.renderer?.resize) {
      app.renderer.resize(w, h)
    }
    root.scale.set(s)
    root.x = (w - DEFAULT_W * s) / 2
    root.y = h - DEFAULT_H * s
    if (model) fitModelInDesignStage(model)
  }

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        const PIXI = await import('pixi.js')
        ;(window as any).PIXI = PIXI

        const { Live2DModel } = await import('pixi-live2d-display/cubism4')
        const Live2DModelAny = Live2DModel as any
        Live2DModelAny.registerTicker(PIXI.Ticker)

        if (cancelled || !canvasRef.current) return

        const canvas = canvasRef.current
        const app = new PIXI.Application({
          view: canvas,
          resizeTo: canvas,
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.max(window.devicePixelRatio || 1, 2),
          autoDensity: true,
        })
        stateRef.current.app = app

        const root = new PIXI.Container()
        app.stage.addChild(root)
        stateRef.current.root = root

        const model = await Live2DModelAny.from(modelUrl, { autoInteract: false })
        if (cancelled) {
          app.destroy(true)
          return
        }

        root.addChild(model)
        stateRef.current.model = model
        try {
          syncStageToCanvas()
        } catch (err) {
          console.warn('[Live2D] initial fit failed:', err)
        }

        model.eventMode = 'none'
        model.interactiveChildren = false

        try {
          coreModelOf(model).setParameterValueById('exp9', 1.0)
        } catch {
          /* 静默 */
        }

        setStatus('ready')
      } catch (err) {
        console.error('[Live2D] 模型加载失败:', err)
        if (!cancelled) setStatus('error')
      }
    }

    void init()

    return () => {
      cancelled = true
      if (stateRef.current.app) {
        stateRef.current.app.destroy(true)
        stateRef.current.app = null
        stateRef.current.root = null
        stateRef.current.model = null
        naturalBoundsRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let rafId = 0
    const sync = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        try {
          syncStageToCanvas()
        } catch {
          /* 静默 */
        }
      })
    }
    const ro = new ResizeObserver(sync)
    ro.observe(canvas)
    sync()
    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl, stageScale, layout])

  useEffect(() => {
    let rafId = 0

    const tick = (timestamp: number) => {
      const { model } = stateRef.current
      if (model) {
        const t = timestamp * 0.001
        const breath = (Math.sin(t * Math.PI * 2 * BREATH_FREQ) + 1) * 0.5
        const ps = petStateRef.current
        const swayAmp = ps === 'working' ? 4.8 : 3
        const sway = Math.sin(t * Math.PI * 2 * SWAY_FREQ) * swayAmp
        try {
          const core = coreModelOf(model)
          core.setParameterValueById('ParamBreath', breath)
          core.setParameterValueById('bodyZ', sway)
          core.setParameterValueById('ParamAngleZ', sway * 0.5)
          core.setParameterValueById('exp9', 1.0)

          for (const p of ALL_EXP_PARAMS) {
            core.setParameterValueById(p, 0)
          }
          const expParam = STATE_EXP[ps]
          if (expParam) core.setParameterValueById(expParam, 1.0)
        } catch {
          /* 静默 */
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const badge = petState !== 'idle' ? STATE_BADGE[petState] : null
  const designWidth = DEFAULT_W * stageScale
  const designHeight = DEFAULT_H * stageScale
  const designLeft = (Number(width) - designWidth) / 2
  const designTop = (Number(height) - designHeight) / 2 + VIEWPORT_MODEL_SHIFT_Y * stageScale
  const badgeScale = 1 + (stageScale - 1) * BADGE_SCALE_DAMPING
  const badgeLocalScale = badgeScale / stageScale

  return (
    <div
      className={`${styles.wrapper} ${className ?? ''}`}
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        className={`${styles.canvas} ${status === 'ready' ? styles.visible : ''}`}
        style={{
          width: designWidth,
          height: designHeight,
          left: designLeft,
          top: designTop,
        }}
      />

      {badge && status === 'ready' && (
        <div
          className={styles.designStage}
          style={{
            width: DEFAULT_W,
            height: DEFAULT_H,
            left: designLeft,
            top: designTop,
            transform: `scale(${stageScale})`,
            transformOrigin: 'top left',
          }}
        >
          <div
            className={`${styles.statusBadge} ${styles[petState] ?? ''}`}
            style={{
              '--badge-tone': badge.tone,
              '--badge-tone-deep': badge.toneDeep,
              '--badge-local-scale': badgeLocalScale,
            } as React.CSSProperties}
            title={badge.text}
          >
            <span className={styles.badgeDot} />
            <span className={styles.badgeText}>{badge.text}</span>
          </div>
        </div>
      )}

      {status === 'loading' && (
        <div className={styles.placeholder}>
          <div className={styles.skeletonAvatar} />
        </div>
      )}

      {status === 'error' && (
        <div className={styles.placeholder}>
          <img src={fallbackImage} alt="看板娘" className={styles.fallbackImg} />
        </div>
      )}
    </div>
  )
}
