import { useContext, useEffect, useRef } from 'react'
import { PetActivityContext } from './petActivityContextValue'
import type { PetActivity } from './whalePetAnimation'

export function usePetActivityState(): PetActivity {
  const context = useContext(PetActivityContext)
  if (!context) {
    throw new Error('usePetActivityState must be used within PetActivityProvider')
  }
  return context.activity
}

const ACTIVE_STATES = new Set<PetActivity>(['extracting', 'resolving', 'saving'])

export function useReportPetActivity(activity: PetActivity): void {
  const context = useContext(PetActivityContext)
  if (!context) {
    throw new Error('useReportPetActivity must be used within PetActivityProvider')
  }
  const setActivity = context.setActivity
  const previousRef = useRef<PetActivity>('idle')

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = activity
    if (ACTIVE_STATES.has(previous) && !ACTIVE_STATES.has(activity) && activity !== 'error') {
      setActivity('success')
      const timer = window.setTimeout(() => setActivity(activity), 2400)
      return () => window.clearTimeout(timer)
    }
    setActivity(activity)
  }, [activity, setActivity])

  useEffect(() => () => setActivity('idle'), [setActivity])
}
