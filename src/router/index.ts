import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'
import { useAuthStore } from '@/stores/auth'
import { useBossStore } from '@/stores/boss'
import { useEcsSessionStore } from '@/stores/ecsSession'

const router = createRouter({
  history: createWebHistory(),
  routes,
})

const PUBLIC_ROUTE_NAMES = new Set(['Login', 'AuthDesktopComplete'])

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore()
  const bossStore = useBossStore()
  const ecsSession = useEcsSessionStore()

  ecsSession.restoreFromStorage()

  const routeName = String(to.name || '')
  const isPublic = PUBLIC_ROUTE_NAMES.has(routeName) || to.meta.public === true

  if (routeName === 'Login' && ecsSession.session) {
    const ok = await ecsSession.refreshSession().catch(() => false)
    if (ok) {
      const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/portal'
      next(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/portal')
      return
    }
  }

  if (!isPublic) {
    const ecsOk = ecsSession.session
      ? await ecsSession.refreshSession().catch(() => false)
      : false
    if (!ecsOk) {
      next({ name: 'Login', query: { redirect: to.fullPath } })
      return
    }

    try {
      const cfg = await bossStore.loadAuthConfig()
      if (cfg.ecsEnabled) {
        await bossStore.refreshSession().catch(() => {})
      }
    } catch (error) {
      console.error('[Router] boss auth check failed:', error)
    }
  }

  // Optional legacy admin gateway — skip when ECS session is active
  if (!isPublic && !ecsSession.isLoggedIn) {
    try {
      const authEnabled = await authStore.checkAuthConfig()
      if (authEnabled && !authStore.isAuthenticated) {
        next({ name: 'Login', query: { redirect: to.fullPath } })
        return
      }
      if (authEnabled && authStore.isAuthenticated) {
        const valid = await authStore.checkAuth()
        if (!valid) {
          next({ name: 'Login', query: { redirect: to.fullPath } })
          return
        }
      }
    } catch {
      /* ECS login is primary */
    }
  }

  next()
})

export default router
