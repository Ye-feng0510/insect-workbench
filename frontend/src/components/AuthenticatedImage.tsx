import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { fetchAuthenticatedAsset } from '@/services/assets'

interface AuthenticatedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  fallbackSrc?: string
  onLoadError?: (message: string) => void
}

export default function AuthenticatedImage({
  src,
  fallbackSrc = '',
  onLoadError,
  onError,
  onLoad,
  ...props
}: AuthenticatedImageProps) {
  const [objectUrl, setObjectUrl] = useState(fallbackSrc)

  useEffect(() => {
    setObjectUrl(fallbackSrc)
    if (!src) {
      return
    }
    let active = true
    let createdUrl = ''
    fetchAuthenticatedAsset(src)
      .then((blob) => {
        if (!active) return
        if (!blob.type.startsWith('image/')) {
          throw new Error('服务返回的内容不是有效图片')
        }
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      })
      .catch((error: unknown) => {
        if (active) {
          setObjectUrl(fallbackSrc)
          onLoadError?.(
            error instanceof Error ? error.message : '图片文件读取失败',
          )
        }
      })
    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [fallbackSrc, onLoadError, src])

  if (!objectUrl) return null

  return (
    <img
      src={objectUrl}
      onLoad={(event) => onLoad?.(event)}
      onError={(event) => {
        onError?.(event)
        if (objectUrl !== fallbackSrc && fallbackSrc) {
          setObjectUrl(fallbackSrc)
        }
        onLoadError?.('图片内容无法解码')
      }}
      {...props}
    />
  )
}
