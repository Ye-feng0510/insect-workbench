import { createContext } from 'react'
import type { PetActivity } from './whalePetAnimation'

export interface PetActivityContextValue {
  activity: PetActivity
  setActivity: (activity: PetActivity) => void
}

export const PetActivityContext = createContext<PetActivityContextValue | null>(null)
