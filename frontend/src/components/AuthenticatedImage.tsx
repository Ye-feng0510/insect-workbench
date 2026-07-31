import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { fetchAuthenticatedAsset } from '@/services/assets'

interface AuthenticatedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  fallbackSrc?: string
}

export default function AuthenticatedImage({
  src,
  fallbackSrc = '',
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
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      })
      .catch(() => {
        if (active) setObjectUrl(fallbackSrc)
      })
    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [fallbackSrc, src])

  return <img src={objectUrl} {...props} />
}
