import { createRouter, createWebHistory } from 'vue-router'

import AgentView from './views/AgentView.vue'
import HomeView from './views/HomeView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/agent', name: 'agent', component: AgentView },
  ],
})
