import {
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { PetActivity } from './whalePetAnimation'
import { PetActivityContext } from './petActivityContextValue'

export function PetActivityProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<PetActivity>('idle')
  const value = useMemo(() => ({ activity, setActivity }), [activity])

  return (
    <PetActivityContext.Provider value={value}>
      {children}
    </PetActivityContext.Provider>
  )
}
