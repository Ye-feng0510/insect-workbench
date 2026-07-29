import { Loader2 } from 'lucide-react'

interface LoadingProps {
  size?: 'sm' | 'md' | 'lg'
  label?: string
}

const sizeMap = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' }

/** 统一的加载状态组件。 */
export default function Loading({ size = 'lg', label }: LoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12">
      <Loader2 className={`${sizeMap[size]} animate-spin text-emerald-600`} />
      {label && <p className="text-sm text-gray-400">{label}</p>}
    </div>
  )
}
