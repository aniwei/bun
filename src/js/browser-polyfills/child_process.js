var EE=require('events');
function ChildProcess(){EE.call(this);this.pid=0;this.exitCode=null;this.signalCode=null;this.stdin={write:function(){return true;},end:function(){},destroy:function(){},on:function(){return this;},once:function(){return this;}};this.stdout=new EE();this.stderr=new EE();}
ChildProcess.prototype=Object.create(EE.prototype);ChildProcess.prototype.constructor=ChildProcess;ChildProcess.prototype.kill=function(){return false;};ChildProcess.prototype.unref=function(){return this;};ChildProcess.prototype.ref=function(){return this;};
function exec(cmd,opts,cb){if(typeof opts==='function'){cb=opts;opts={};}var cp=new ChildProcess();if(cb)setTimeout(function(){cb(new Error('exec not supported in browser WASM mode'),null,null);},0);return cp;}
function spawn(cmd,args,opts){var cp=new ChildProcess();setTimeout(function(){cp.exitCode=1;cp.emit('close',1,null);},0);return cp;}
function fork(mod,args,opts){return spawn('node',[mod].concat(args||[]),opts);}
function execFile(file,args,opts,cb){if(typeof args==='function'){cb=args;args=[];opts={};}else if(typeof opts==='function'){cb=opts;opts={};}var cp=new ChildProcess();if(cb)setTimeout(function(){cb(new Error('execFile not supported in browser WASM mode'),null,null);},0);return cp;}
function spawnSync(){return{pid:0,output:[],stdout:new Uint8Array(0),stderr:new Uint8Array(0),status:1,signal:null,error:new Error('spawnSync not supported in browser WASM mode')};}
function execSync(){throw new Error('execSync not supported in browser WASM mode');}
function execFileSync(){throw new Error('execFileSync not supported in browser WASM mode');}
module.exports={exec:exec,execSync:execSync,spawn:spawn,spawnSync:spawnSync,fork:fork,execFile:execFile,execFileSync:execFileSync,ChildProcess:ChildProcess};
