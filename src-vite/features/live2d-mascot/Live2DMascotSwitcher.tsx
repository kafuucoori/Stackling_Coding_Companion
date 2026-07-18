/**
 * Live2DMascotSwitcher —— 包住 Live2DMascot，从 manifest 读模型清单提供切换器。
 * showPicker=false 时隐藏切换按钮、纯展示。
 */

import { useEffect, useState } from 'react'
import Live2DMascot, { type MascotPetState } from './Live2DMascot'
import {
  loadLive2DModels,
  modelUrlOf,
  thumbnailUrlOf,
  DEFAULT_MODEL_ID,
  type Live2DModelEntry,
} from './live2dModels'
import styles from './Live2DMascotSwitcher.module.css'

interface Live2DMascotSwitcherProps {
  initialModelId?: string
  showPicker?: boolean
  width?: number
  height?: number
  className?: string
  petState?: MascotPetState
  stageScale?: number
  onModelChange?: (entry: Live2DModelEntry) => void
}

export default function Live2DMascotSwitcher({
  initialModelId,
  showPicker = true,
  width,
  height,
  className,
  petState,
  stageScale,
  onModelChange,
}: Live2DMascotSwitcherProps) {
  const [models, setModels] = useState<Live2DModelEntry[]>([])
  const [currentId, setCurrentId] = useState<string>(initialModelId ?? DEFAULT_MODEL_ID)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadLive2DModels()
      .then((list) => {
        if (cancelled) return
        setModels(list)
        if (list.length > 0 && !list.some((m) => m.id === currentId)) {
          setCurrentId(list[0].id)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = models.find((m) => m.id === currentId)
  const modelUrl = current ? modelUrlOf(current) : undefined
  const fallbackImage = current ? thumbnailUrlOf(current) : undefined

  const handlePick = (entry: Live2DModelEntry) => {
    setCurrentId(entry.id)
    setPickerOpen(false)
    onModelChange?.(entry)
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <Live2DMascot
        key={currentId}
        modelUrl={modelUrl}
        fallbackImage={fallbackImage}
        width={width}
        height={height}
        petState={petState}
        stageScale={stageScale}
        layout={current?.layout}
      />

      {showPicker && (
        <>
          <button
            type="button"
            className={styles.toggle}
            title="切换模型"
            onClick={() => setPickerOpen((v) => !v)}
          >
            ⇄
          </button>

          {pickerOpen && (
            <div className={styles.panel}>
              {error && <div className={styles.err}>清单加载失败</div>}
              {!error && models.length === 0 && <div className={styles.err}>无可用模型</div>}
              {models.map((m) => {
                const thumb = thumbnailUrlOf(m)
                const active = m.id === currentId
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`${styles.item} ${active ? styles.itemActive : ''}`}
                    onClick={() => handlePick(m)}
                  >
                    {thumb ? (
                      <img src={thumb} alt={m.name} className={styles.thumb} />
                    ) : (
                      <div className={styles.thumbPlaceholder} />
                    )}
                    <span className={styles.name}>{m.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
