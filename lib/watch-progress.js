// Show a bounded description of activity, never raw tool arguments or model reasoning.
function toolStage(tool, label = '') {
  const name = `${tool || ''} ${label || ''}`.toLowerCase();
  if (/nutritrace.*(log_food|log_meal|create_food|edit_diary|delete_diary)/.test(name)) return 'Saving food entry';
  if (/nutritrace.*(list_diary|get_daily_totals)/.test(name)) return 'Checking food entry';
  if (/tandoor|recipe/.test(name)) return 'Checking recipe';
  if (/nutritrace.*(search|get_recent|get_meal)/.test(name)) return 'Finding food';
  if (/tool_search|tool_describe/.test(name)) return 'Finding tools';
  if (/memory/.test(name)) return 'Updating memory';
  return 'Using a tool';
}
function streamStage(event, data) {
  if (event === 'hermes.tool.progress') return data.status === 'completed' ? 'Reviewing results' : toolStage(data.tool, data.label);
  if (event === 'hermes.status') {
    const kind = String(data.kind || '').toLowerCase();
    if (/compress|compact/.test(kind)) return 'Compacting context';
    if (/wait|retry|overload|load/.test(kind)) return 'Waiting for model';
    return 'Working';
  }
  const delta = data.choices && data.choices[0] && data.choices[0].delta || {};
  if (delta.content) return 'Writing reply';
  if (delta.reasoning_content || delta.reasoning) return 'Thinking';
  return null;
}
module.exports = { toolStage, streamStage };
