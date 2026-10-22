export function backendSendError(status:string,models:readonly string[]):string|null{
 if(status==='ready'||models.length>0&&models.every(model=>model.startsWith('claude-code:')))return null;
 return status==='starting'?'Chat engine is starting. Your draft is saved.':'Chat engine is offline. Restore the connection to send. Your draft is saved.';
}
