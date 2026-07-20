<script setup lang="ts">
import type { CreateRunRequest, RunStatus } from '@viewport-lab/shared'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { computed, reactive, ref } from 'vue'

import { useRunStore } from '../stores/run'

const store = useRunStore()
const formRef = ref<FormInstance>()
const form = reactive<CreateRunRequest>({
  url: 'http://localhost:5188',
  viewport: { width: 360, height: 800 },
  deviceScaleFactor: 1,
  fullPage: false,
  readySelector: '',
})

const rules: FormRules<CreateRunRequest> = {
  url: [
    { required: true, message: '请输入目标页面 URL', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        try {
          const url = new URL(value)
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
          callback()
        } catch {
          callback(new Error('请输入有效的 HTTP 或 HTTPS URL'))
        }
      },
      trigger: 'blur',
    },
  ],
}

const statusText: Record<RunStatus, string> = {
  queued: '等待',
  launching: '启动浏览器',
  navigating: '打开页面',
  waiting: '等待页面',
  capturing: '截图中',
  completed: '完成',
  failed: '失败',
}

const currentStatus = computed(() => (store.run ? statusText[store.run.status] : '等待'))
const statusType = computed(() => {
  if (store.run?.status === 'completed') return 'success'
  if (store.run?.status === 'failed') return 'danger'
  return 'primary'
})

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    await store.createRun({
      ...form,
      viewport: { ...form.viewport },
      readySelector: form.readySelector.trim(),
    })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建截图任务失败')
  }
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}
</script>

<template>
  <main class="page-shell">
    <header class="page-header">
      <div>
        <p class="eyebrow">H5 SCREENSHOT TOOL</p>
        <h1>Viewport Lab</h1>
        <p class="subtitle">输入页面地址和视口参数，用 Chromium 生成一张本地截图。</p>
      </div>
      <el-tag :type="statusType" effect="light" size="large">{{ currentStatus }}</el-tag>
    </header>

    <section class="workspace">
      <el-card class="panel" shadow="never">
        <template #header><strong>截图设置</strong></template>
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
          <el-form-item label="目标页面完整 URL" prop="url">
            <el-input v-model="form.url" placeholder="http://localhost:8080" />
          </el-form-item>

          <div class="field-grid">
            <el-form-item label="Viewport width">
              <el-input-number
                v-model="form.viewport.width"
                :min="1"
                :step="10"
                controls-position="right"
              />
            </el-form-item>
            <el-form-item label="Viewport height">
              <el-input-number
                v-model="form.viewport.height"
                :min="1"
                :step="10"
                controls-position="right"
              />
            </el-form-item>
            <el-form-item label="Device scale factor">
              <el-input-number
                v-model="form.deviceScaleFactor"
                :min="0.1"
                :step="0.5"
                controls-position="right"
              />
            </el-form-item>
          </div>

          <el-form-item label="页面就绪选择器（可选）">
            <el-input v-model="form.readySelector" placeholder="#app-ready" />
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="form.fullPage">截取完整页面（fullPage）</el-checkbox>
          </el-form-item>
          <el-button type="primary" :loading="store.submitting" @click="submit">开始截图</el-button>
        </el-form>
      </el-card>

      <el-card class="panel preview-panel" shadow="never">
        <template #header><strong>设备预览</strong></template>
        <div v-if="store.run?.status === 'completed' && store.run.screenshotUrl" class="result">
          <div class="device-frame">
            <img :src="store.run.screenshotUrl" alt="Viewport screenshot" />
          </div>
          <dl class="metadata">
            <div>
              <dt>URL</dt>
              <dd>{{ store.run.request.url }}</dd>
            </div>
            <div>
              <dt>Viewport</dt>
              <dd>
                {{ store.run.request.viewport.width }} × {{ store.run.request.viewport.height }}
              </dd>
            </div>
            <div>
              <dt>DPR</dt>
              <dd>{{ store.run.request.deviceScaleFactor }}</dd>
            </div>
            <div>
              <dt>截图时间</dt>
              <dd>{{ formatTime(store.run.completedAt) }}</dd>
            </div>
          </dl>
        </div>
        <el-result
          v-else-if="store.run?.status === 'failed'"
          icon="error"
          title="截图失败"
          :sub-title="store.run.error ?? '未知错误'"
        />
        <el-empty v-else description="完成截图后，结果会显示在这里" />
      </el-card>
    </section>
  </main>
</template>
