import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'
import { useAuthStore } from '@/stores/auth'
import { useBossStore } from '@/stores/boss'

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore()
  const bossStore = useBossStore()

  let authEnabled = false
  try {
    authEnabled = await authStore.checkAuthConfig()
  } catch (error) {
    console.error('[Router] checkAuthConfig failed:', error)
    authEnabled = false
  }

  if (!authEnabled) {
    if (to.name === 'Login') {
      next({ name: 'PixelOffice' })
      return
    }
  } else {
    if (to.meta.public) {
      if (to.name === 'Login' && authStore.isAuthenticated) {
        try {
          const valid = await authStore.checkAuth()
          if (valid) {
            const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/'
            next(redirect)
            return
          }
        } catch (error) {
          console.error('[Router] checkAuth failed:', error)
        }
      }
    } else if (!authStore.isAuthenticated) {
      next({ name: 'Login', query: { redirect: to.fullPath } })
      return
    } else {
      try {
        const valid = await authStore.checkAuth()
        if (!valid) {
          next({ name: 'Login', query: { redirect: to.fullPath } })
          return
        }
      } catch (error) {
        console.error('[Router] checkAuth failed:', error)
        next({ name: 'Login', query: { redirect: to.fullPath } })
        return
      }
    }
  }

  if (to.name !== 'BossLogin' && to.meta.public !== true) {
    try {
      const cfg = await bossStore.loadAuthConfig()
      if (cfg.ecsEnabled) {
        const ok = await bossStore.refreshSession()
        if (!ok) {
          next({ name: 'BossLogin', query: { redirect: to.fullPath } })
          return
        }
      }
    } catch (error) {
      console.error('[Router] boss auth check failed:', error)
    }
  }

  next()
})

export default router
