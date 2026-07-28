import { createRouter, createWebHistory } from 'vue-router'

import ConfigurationListView from './views/ConfigurationListView.vue'
import HomeView from './views/HomeView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/configurations',
      name: 'configurations',
      component: ConfigurationListView,
    },
    { path: '/agent', redirect: '/' },
    { path: '/batch', redirect: '/' },
  ],
})
