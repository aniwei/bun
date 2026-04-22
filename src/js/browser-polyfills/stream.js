var EE=require('events');
function inherits(C,P){C.prototype=Object.create(P.prototype);C.prototype.constructor=C;}
function Readable(o){EE.call(this);this.readable=true;this._rs={ended:false,hwm:(o&&o.highWaterMark)||16384};if(o&&o.read)this._read=o.read;}
inherits(Readable,EE);
Readable.prototype._read=function(){this.push(null);};
Readable.prototype.push=function(c){if(c===null){if(!this._rs.ended){this._rs.ended=true;this.emit('end');}return false;}this.emit('data',c);return true;};
Readable.prototype.read=function(){return null;};
Readable.prototype.pipe=function(d,o){var self=this;this.on('data',function(c){d.write(c);});this.on('end',function(){if(!o||o.end!==false)d.end();});d.emit('pipe',self);return d;};
Readable.prototype.unpipe=function(d){this.removeAllListeners('data');if(d)d.emit('unpipe',this);return this;};
Readable.prototype.resume=function(){return this;};
Readable.prototype.pause=function(){return this;};
Readable.prototype.destroy=function(e){if(e)this.emit('error',e);this.emit('close');return this;};
Readable.prototype.setEncoding=function(){return this;};
if(typeof Symbol!=='undefined'&&Symbol.asyncIterator){Readable.prototype[Symbol.asyncIterator]=function(){var self=this;var done=false;return{next:function(){return new Promise(function(res){if(done)return res({value:undefined,done:true});if(self._rs.ended)return res({value:undefined,done:true});var od=function(){done=true;res({value:undefined,done:true});};self.once('data',function(v){self.removeListener('end',od);res({value:v,done:false});});self.once('end',od);});},return:function(){return Promise.resolve({done:true});}};};};
Readable.from=function(iter,o){var r=new Readable(o);var items=Array.isArray(iter)?iter.slice():Array.from(iter);setTimeout(function(){for(var i=0;i<items.length;i++)r.push(items[i]);r.push(null);},0);return r;};
function Writable(o){EE.call(this);this.writable=true;this._ws={ended:false,hwm:(o&&o.highWaterMark)||16384};if(o&&o.write)this._write=o.write;if(o&&o.final)this._final=o.final;}
inherits(Writable,EE);
Writable.prototype._write=function(c,e,cb){cb();};
Writable.prototype.write=function(c,e,cb){if(typeof e==='function'){cb=e;e='utf8';}if(this._ws.ended){this.emit('error',new Error('write after end'));return false;}this._write(c,e||'utf8',cb||function(){});return true;};
Writable.prototype.end=function(c,e,cb){if(typeof c==='function'){cb=c;c=null;}else if(typeof e==='function'){cb=e;e=null;}if(c!=null)this.write(c,e);this._ws.ended=true;var self=this;if(typeof this._final==='function')this._final(function(){self.emit('finish');if(typeof cb==='function')cb();});else{this.emit('finish');if(typeof cb==='function')cb();}return this;};
Writable.prototype.destroy=function(e){if(e)this.emit('error',e);this.emit('close');return this;};
Writable.prototype.setDefaultEncoding=function(){return this;};
function Duplex(o){Readable.call(this,o);this._ws={ended:false,hwm:(o&&o.highWaterMark)||16384};if(o&&o.write)this._write=o.write;if(o&&o.final)this._final=o.final;}
inherits(Duplex,Readable);
Duplex.prototype.write=Writable.prototype.write;Duplex.prototype.end=Writable.prototype.end;Duplex.prototype._write=Writable.prototype._write;Duplex.prototype.setDefaultEncoding=Writable.prototype.setDefaultEncoding;
function Transform(o){Duplex.call(this,o);if(o&&o.transform)this._transform=o.transform;if(o&&o.flush)this._flush=o.flush;}
inherits(Transform,Duplex);
Transform.prototype._transform=function(c,e,cb){cb(null,c);};
Transform.prototype._flush=function(cb){cb();};
Transform.prototype._write=function(c,e,cb){var self=this;this._transform(c,e,function(err,d){if(err){self.emit('error',err);return;}if(d!=null)self.push(d);cb();});};
Transform.prototype.end=function(c,e,cb){if(typeof c==='function'){cb=c;c=null;}else if(typeof e==='function'){cb=e;e=null;}if(c!=null)this.write(c,e);var self=this;this._flush(function(err,d){if(err){self.emit('error',err);return;}if(d!=null)self.push(d);self.push(null);self._ws.ended=true;self.emit('finish');if(typeof cb==='function')cb();});return this;};
function PassThrough(o){Transform.call(this,o);}
inherits(PassThrough,Transform);
PassThrough.prototype._transform=function(c,e,cb){cb(null,c);};
function pipeline(){var s=Array.prototype.slice.call(arguments);var cb=typeof s[s.length-1]==='function'?s.pop():null;if(s.length<2){if(cb)cb(new Error('need at least 2 streams'));return;}s[0].on('error',function(e){if(cb)cb(e);});for(var i=0;i<s.length-1;i++)s[i].pipe(s[i+1]);var last=s[s.length-1];if(last.once)last.once('finish',function(){if(cb)cb(null);});return last;}
function finished(s,o,cb){if(typeof o==='function'){cb=o;}var done=false;function d(e){if(!done){done=true;cb(e||null);}}s.once('end',d);s.once('finish',d);s.once('error',d);return function(){};}
var Stream=Readable;Stream.Readable=Readable;Stream.Writable=Writable;Stream.Duplex=Duplex;Stream.Transform=Transform;Stream.PassThrough=PassThrough;Stream.pipeline=pipeline;Stream.finished=finished;Stream.Stream=Stream;
module.exports=Stream;
