function EventEmitter(){this._events=Object.create(null);this._maxListeners=0;}
EventEmitter.defaultMaxListeners=10;
EventEmitter.prototype.setMaxListeners=function(n){this._maxListeners=n;return this;};
EventEmitter.prototype.getMaxListeners=function(){return this._maxListeners||EventEmitter.defaultMaxListeners;};
EventEmitter.prototype.eventNames=function(){return Object.keys(this._events);};
EventEmitter.prototype.listeners=function(t){return(this._events[t]||[]).map(function(f){return f._orig||f;});};
EventEmitter.prototype.rawListeners=function(t){return(this._events[t]||[]).slice();};
EventEmitter.prototype.listenerCount=function(t){return(this._events[t]||[]).length;};
EventEmitter.listenerCount=function(ee,t){return ee.listenerCount(t);};
EventEmitter.prototype.on=EventEmitter.prototype.addListener=function(t,fn){
  if(!this._events[t])this._events[t]=[];
  this._events[t].push(fn);
  return this;
};
EventEmitter.prototype.once=function(t,fn){
  var self=this;
  function w(){self.removeListener(t,w);fn.apply(self,arguments);}
  w._orig=fn;
  return this.on(t,w);
};
EventEmitter.prototype.prependListener=function(t,fn){
  if(!this._events[t])this._events[t]=[];
  this._events[t].unshift(fn);
  return this;
};
EventEmitter.prototype.prependOnceListener=function(t,fn){
  var self=this;
  function w(){self.removeListener(t,w);fn.apply(self,arguments);}
  w._orig=fn;
  return this.prependListener(t,w);
};
EventEmitter.prototype.removeListener=EventEmitter.prototype.off=function(t,fn){
  var list=this._events[t];
  if(!list)return this;
  this._events[t]=list.filter(function(f){return f!==fn&&f._orig!==fn;});
  if(!this._events[t].length)delete this._events[t];
  return this;
};
EventEmitter.prototype.removeAllListeners=function(t){
  if(arguments.length&&t!==undefined)delete this._events[t];
  else this._events=Object.create(null);
  return this;
};
EventEmitter.prototype.emit=function(t){
  var list=this._events[t];
  if(!list||!list.length){
    if(t==='error'){var e=arguments[1];if(!(e instanceof Error))e=new Error('Unhandled "error" event');throw e;}
    return false;
  }
  var args=Array.prototype.slice.call(arguments,1);
  list.slice().forEach(function(f){f.apply(this,args);},this);
  return true;
};
function inherits(ctor,superCtor){
  ctor.super_=superCtor;
  ctor.prototype=Object.create(superCtor.prototype,{constructor:{value:ctor,writable:true,configurable:true}});
}
EventEmitter.inherits=inherits;
module.exports=EventEmitter;
module.exports.EventEmitter=EventEmitter;
module.exports.inherits=inherits;
