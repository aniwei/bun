var EE=require('events');
function _inherits(C,P){C.prototype=Object.create(P.prototype);C.prototype.constructor=C;}

// ── IncomingMessage ───────────────────────────────────────────────────────────
// Accepts either a Bun/Web Request object (T5.17 server path)
// or legacy (url, method, headers) arguments (T5.xx client path).
function IncomingMessage(urlOrReq,method,headers){
  EE.call(this);
  if(urlOrReq&&typeof urlOrReq==='object'&&urlOrReq.url&&urlOrReq.method){
    var u;try{u=new URL(urlOrReq.url);}catch(e){u=null;}
    this.url=u?(u.pathname+(u.search||'')):(urlOrReq.url||'/');
    this.method=(urlOrReq.method||'GET').toUpperCase();
    this.headers={};
    if(urlOrReq.headers&&typeof urlOrReq.headers.forEach==='function'){
      urlOrReq.headers.forEach(function(v,k){this.headers[k]=v;},this);
    }
    this._bunReq=urlOrReq;
  }else{
    this.url=(typeof urlOrReq==='string'?urlOrReq:'/')||'/';
    this.method=(method||'GET').toUpperCase();
    this.headers=headers||{};
    this._bunReq=null;
  }
  this.statusCode=200;this.statusMessage='OK';
  this._bodyScheduled=false;
}
_inherits(IncomingMessage,EE);

// Lazily read body from Bun Request: fires 'data' then 'end' events.
IncomingMessage.prototype._scheduleBody=function(){
  if(this._bodyScheduled)return;
  this._bodyScheduled=true;
  var self=this;
  if(!this._bunReq||!this._bunReq.body){setTimeout(function(){self.emit('end');},0);return;}
  this._bunReq.arrayBuffer().then(function(ab){
    if(ab&&ab.byteLength>0)self.emit('data',new Uint8Array(ab));
    self.emit('end');
  }).catch(function(e){self.emit('error',e);});
};
// Override on() to auto-start body reading when data/end listeners are added.
IncomingMessage.prototype.on=function(ev,fn){
  EE.prototype.on.call(this,ev,fn);
  if(ev==='data'||ev==='end'||ev==='readable')this._scheduleBody();
  return this;
};
IncomingMessage.prototype.resume=function(){this._scheduleBody();return this;};
IncomingMessage.prototype.pipe=function(dest){
  this.on('data',function(c){dest.write&&dest.write(c);});
  this.on('end',function(){dest.end&&dest.end();});
  return dest;
};
IncomingMessage.prototype.destroy=function(){return this;};
IncomingMessage.prototype.setTimeout=function(){return this;};

// ── ServerResponse ────────────────────────────────────────────────────────────
// resolve: a Promise resolver supplied by createServer's fetch handler.
function ServerResponse(resolve){
  EE.call(this);
  this.statusCode=200;this.statusMessage='OK';
  this.headers={};this._chunks=[];this._resolve=resolve||null;
  this.headersSent=false;this.finished=false;
}
_inherits(ServerResponse,EE);
ServerResponse.prototype.setHeader=function(k,v){this.headers[k.toLowerCase()]=v;return this;};
ServerResponse.prototype.getHeader=function(k){return this.headers[k.toLowerCase()];};
ServerResponse.prototype.removeHeader=function(k){delete this.headers[k.toLowerCase()];};
ServerResponse.prototype.writeHead=function(code,msg,h){
  this.statusCode=code;
  if(typeof msg==='object'&&msg!==null)Object.assign(this.headers,msg);
  else if(h&&typeof h==='object')Object.assign(this.headers,h);
  return this;
};
ServerResponse.prototype.write=function(d,enc,cb){
  if(typeof enc==='function'){cb=enc;enc=null;}
  if(d!=null){
    var c=typeof d==='string'?new TextEncoder().encode(d):
      (d instanceof Uint8Array?d:
      (ArrayBuffer.isView(d)?new Uint8Array(d.buffer,d.byteOffset,d.byteLength):
      new TextEncoder().encode(String(d))));
    this._chunks.push(c);
  }
  if(cb)setTimeout(cb,0);
  return true;
};
ServerResponse.prototype.end=function(d,enc,cb){
  if(typeof d==='function'){cb=d;d=null;}
  else if(typeof enc==='function'){cb=enc;enc=null;}
  if(d!=null)this.write(d,enc);
  this.finished=true;this.headersSent=true;
  var total=0,i;
  for(i=0;i<this._chunks.length;i++)total+=this._chunks[i].byteLength;
  var body=new Uint8Array(total),off=0;
  for(i=0;i<this._chunks.length;i++){body.set(this._chunks[i],off);off+=this._chunks[i].byteLength;}
  var h=Object.assign({'content-length':String(total)},this.headers);
  if(this._resolve)this._resolve(new Response(body,{status:this.statusCode,statusText:this.statusMessage||'OK',headers:h}));
  if(cb)setTimeout(cb,0);
  this.emit('finish');
  return this;
};

// ── createServer ──────────────────────────────────────────────────────────────
// Delegates to Bun.serve when listen() is called, bridging IncomingMessage /
// ServerResponse to the Bun Request/Response model.
function createServer(handler){
  var _handler=handler||null;
  var _server=null;
  var srv={
    on:function(){return srv;},
    once:function(){return srv;},
    emit:function(){return srv;},
    address:function(){return _server?{port:_server.port,family:'IPv4',address:'127.0.0.1'}:{port:0,family:'IPv4',address:'127.0.0.1'};},
    listen:function(port,host,cb){
      if(typeof host==='function'){cb=host;host=undefined;}
      if(typeof port==='function'){cb=port;port=0;}
      if(!_handler)throw new Error('http.createServer: no request handler');
      _server=Bun.serve({
        port:port||0,
        hostname:host||'localhost',
        fetch:function(req){
          return new Promise(function(resolve){
            var inMsg=new IncomingMessage(req);
            var outMsg=new ServerResponse(resolve);
            try{_handler(inMsg,outMsg);}
            catch(e){resolve(new Response(String(e),{status:500}));}
          });
        },
      });
      if(cb)setTimeout(cb,0);
      return srv;
    },
    close:function(cb){
      if(_server){try{_server.stop();}catch(e){}_server=null;}
      if(cb)setTimeout(cb,0);
      return srv;
    },
  };
  return srv;
}

// ── outgoing http.request / http.get ─────────────────────────────────────────
function _mkReq(opts,cb){if(typeof opts==='string')opts={href:opts};var url=opts.href||opts.url||((opts.protocol||'http:')+'//'+(opts.host||opts.hostname||'localhost')+(opts.port?':'+opts.port:'')+(opts.path||'/'));var method=(opts.method||'GET').toUpperCase(),chunks=[],hdrs=opts.headers||{};var req=Object.create(EE.prototype);EE.call(req);req.write=function(d){chunks.push(typeof d==='string'?d:new TextDecoder().decode(d instanceof Uint8Array?d:new Uint8Array(d.buffer||d)));return true;};req.end=function(d,e,cb2){if(typeof d==='function'){cb2=d;d=null;}if(d)req.write(d);var body=chunks.length&&method!=='GET'&&method!=='HEAD'?chunks.join(''):undefined;fetch(url,{method:method,headers:hdrs,body:body}).then(function(r){var res=new IncomingMessage(url,method,{});r.headers.forEach(function(v,k){res.headers[k]=v;});res.statusCode=r.status;res.statusMessage=r.statusText||'';if(cb)cb(res);return r.arrayBuffer();}).then(function(ab){}).catch(function(e){req.emit('error',e);});if(cb2)setTimeout(cb2,0);return req;};req.setHeader=function(k,v){hdrs[k.toLowerCase()]=v;return req;};req.getHeader=function(k){return hdrs[k.toLowerCase()];};req.setTimeout=function(){return req;};req.destroy=function(){return req;};req.abort=function(){};return req;}

var STATUS_CODES={100:'Continue',200:'OK',201:'Created',202:'Accepted',204:'No Content',206:'Partial Content',301:'Moved Permanently',302:'Found',304:'Not Modified',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',408:'Request Timeout',409:'Conflict',422:'Unprocessable Entity',429:'Too Many Requests',500:'Internal Server Error',501:'Not Implemented',502:'Bad Gateway',503:'Service Unavailable',504:'Gateway Timeout'};
module.exports={request:_mkReq,get:function(o,cb){var r=_mkReq(o,cb);r.end();return r;},createServer:createServer,STATUS_CODES:STATUS_CODES,IncomingMessage:IncomingMessage,ServerResponse:ServerResponse,METHODS:['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','TRACE','CONNECT'],globalAgent:{maxSockets:Infinity}};
