import type { ReactNode } from 'react'
import CinematicLoginScene, {
  type LoginScenePhase,
} from '@/features/login/CinematicLoginScene'

interface OceanBackgroundProps {
  children: ReactNode
  phase?: LoginScenePhase
}

export default function OceanBackground({ children, phase }: OceanBackgroundProps) {
  return <CinematicLoginScene phase={phase}>{children}</CinematicLoginScene>
}
