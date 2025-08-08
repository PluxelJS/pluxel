import React, { useEffect, useState } from 'react'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import { prettyLine } from './pretty'

interface Props { module?: string }

export function LiveLog({ module }: Props) {
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 切模块时先清空
    setLogs([])
    setError(null)

    const params = new URLSearchParams()
    if (module) params.set('name', module)
    const es = new EventSource(`/api/logs/stream?${params}`)

    es.onmessage = (e) => {
      setLogs((prev) => [...prev, prettyLine(e.data)])
    }
    es.onerror = () => {
      setError('日志流中断')
      es.close()
    }

    return () => es.close()
  }, [module])

  if (error) return <div style={{ color: 'red' }}>加载日志出错：{error}</div>

  return (
    <ScrollFollow
      startFollowing
      render={({ follow, onScroll }) => (
        <LazyLog
          text={logs.join('\n')}
          external
          stream={false}
          follow={follow}
          onScroll={onScroll}
          selectableLines
          format="ansi"
          wrapLines
        />
      )}
    />
  )
}
