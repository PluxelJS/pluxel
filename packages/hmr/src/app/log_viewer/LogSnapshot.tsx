/* // src/components/LogSnapshot.tsx
import React, { useEffect, useState } from 'react'
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer'
import { prettyLine } from './pretty'

interface Props {
  module?: string
  limit?: number
}

export function LogSnapshot({ module, limit = 100 }: Props) {
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLogs([])
    setError(null)

    const params = new URLSearchParams()
    if (module) params.set('name', module)
    params.set('limit', String(limit))

    fetch(`/api/logs/latest?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`状态码 ${res.status}`)
        return res.text()
      })
      .then((txt) => {
        const lines = txt
          .split('\n')
          .filter((l) => l.trim())
          .map(prettyLine)
        setLogs(lines)
      })
      .catch((err) => {
        setError(err.message)
      })
  }, [module, limit])

  if (error) {
    return <div style={{ color: 'red' }}>加载日志失败：{error}</div>
  }

  return (
    <ScrollFollow
      startFollowing
      render={({ follow, onScroll }) => (
      <LazyLog
        text={logs.join('\n')}
        external={true}
        stream={false}
        follow={follow} onScroll={onScroll}
        selectableLines={true}
        format="ansi"
        wrapLines={true}
      />)}
    />
  )
}
 */
