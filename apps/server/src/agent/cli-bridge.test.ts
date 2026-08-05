import assert from 'node:assert/strict'
import test from 'node:test'

import { isCliModalStateError, parseCliModalState } from './cli-bridge.js'

test('parses native dialog type and Chinese message from Playwright CLI text output', () => {
  const output = `### Error
Error: Tool "browser_snapshot" does not handle the modal state.
### Modal state
- ["confirm" dialog with message "确定提交课程吗？"]: can be handled by dialog-accept or dialog-dismiss`

  assert.deepEqual(parseCliModalState(output), {
    kind: 'dialog',
    type: 'confirm',
    message: '确定提交课程吗？',
  })
})

test('parses prompt and beforeunload dialogs and ignores output without a dialog', () => {
  assert.deepEqual(
    parseCliModalState(
      '- ["prompt" dialog with message "请输入姓名"]: can be handled by dialog-accept or dialog-dismiss',
    ),
    { kind: 'dialog', type: 'prompt', message: '请输入姓名' },
  )
  assert.deepEqual(
    parseCliModalState(
      '- ["beforeunload" dialog with message ""]: can be handled by dialog-accept or dialog-dismiss',
    ),
    { kind: 'dialog', type: 'beforeunload', message: '' },
  )
  assert.equal(parseCliModalState('### Page\n- URL: about:blank'), null)
  assert.deepEqual(
    parseCliModalState(
      '- ["alert" dialog with message "第一行\n第二行"]: can be handled by dialog-accept or dialog-dismiss',
    ),
    { kind: 'dialog', type: 'alert', message: '第一行\n第二行' },
  )
})

test('classifies file chooser and unsupported modal states separately', () => {
  assert.deepEqual(
    parseCliModalState('### Modal state\n- [File chooser]: can be handled by upload'),
    { kind: 'fileChooser', description: 'File chooser' },
  )
  assert.deepEqual(
    parseCliModalState('### Modal state\n- [Download prompt]: can be handled externally'),
    { kind: 'unsupported', description: '- [Download prompt]: can be handled externally' },
  )
})

test('recognizes the generic modal-state error returned by JSON mode', () => {
  assert.equal(
    isCliModalStateError('Error: Tool "browser_take_screenshot" does not handle the modal state.'),
    true,
  )
  assert.equal(isCliModalStateError('locator.click: Timeout 30000ms exceeded'), false)
})
