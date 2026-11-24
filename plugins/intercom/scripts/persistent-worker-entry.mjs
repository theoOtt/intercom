import {BUNDLE} from './persistent-common.mjs';
import {pathToFileURL} from 'node:url';
let loaded=false,ended=false;
process.stdin.once('end',()=>{ended=true;if(loaded)process.emit('SIGTERM');});
await import(pathToFileURL(BUNDLE).href);
loaded=true;if(ended)process.emit('SIGTERM');
