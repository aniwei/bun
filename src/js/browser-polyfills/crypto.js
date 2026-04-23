function _u8(d){if(typeof d==='string')return new TextEncoder().encode(d);if(d instanceof Uint8Array)return d;if(d instanceof ArrayBuffer)return new Uint8Array(d);if(d&&d._data instanceof Uint8Array)return d._data;if(d&&d.buffer instanceof ArrayBuffer)return new Uint8Array(d.buffer,d.byteOffset||0,d.byteLength||d.length||0);return new Uint8Array(0);}
function _hex(b){return Array.from(b).map(function(x){return('0'+x.toString(16)).slice(-2);}).join('');}
function _rotr(x,n){return(x>>>n)|(x<<(32-n));}
function _rotl(x,n){return(x<<n)|(x>>>(32-n));}
function _sha256(msg){
  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var m=_u8(msg),l=m.length,bl=l*8,pad=new Uint8Array((((l+8)>>6)+1)<<6);
  pad.set(m);pad[l]=0x80;var dv=new DataView(pad.buffer);dv.setUint32(pad.length-4,bl>>>0,false);dv.setUint32(pad.length-8,Math.floor(bl/4294967296)>>>0,false);
  var W=new Int32Array(64);
  for(var b=0,nb=pad.length>>6;b<nb;b++){
    for(var i=0;i<16;i++)W[i]=dv.getInt32((b*16+i)*4,false);
    for(var i=16;i<64;i++){var s0=(_rotr(W[i-15],7)^_rotr(W[i-15],18)^(W[i-15]>>>3))|0;var s1=(_rotr(W[i-2],17)^_rotr(W[i-2],19)^(W[i-2]>>>10))|0;W[i]=(W[i-16]+s0+W[i-7]+s1)|0;}
    var a=H[0],b_=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(var i=0;i<64;i++){var S1=(_rotr(e,6)^_rotr(e,11)^_rotr(e,25))|0;var ch=((e&f)^(~e&g))|0;var t1=(h+S1+ch+K[i]+W[i])|0;var S0=(_rotr(a,2)^_rotr(a,13)^_rotr(a,22))|0;var maj=((a&b_)^(a&c)^(b_&c))|0;var t2=(S0+maj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b_;b_=a;a=(t1+t2)|0;}
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b_)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
  }
  var out=new Uint8Array(32);for(var i=0;i<8;i++)new DataView(out.buffer,i*4,4).setUint32(0,H[i]>>>0,false);return out;
}
function _sha1(msg){
  var H=[0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0];
  var m=_u8(msg),l=m.length,bl=l*8,pad=new Uint8Array((((l+8)>>6)+1)<<6);
  pad.set(m);pad[l]=0x80;var dv=new DataView(pad.buffer);dv.setUint32(pad.length-4,bl>>>0,false);dv.setUint32(pad.length-8,Math.floor(bl/4294967296)>>>0,false);
  var W=new Int32Array(80);
  for(var b=0,nb=pad.length>>6;b<nb;b++){
    for(var i=0;i<16;i++)W[i]=dv.getInt32((b*16+i)*4,false);
    for(var i=16;i<80;i++)W[i]=_rotl(W[i-3]^W[i-8]^W[i-14]^W[i-16],1);
    var a=H[0],b_=H[1],c=H[2],d=H[3],e=H[4];
    for(var i=0;i<80;i++){var f,k;if(i<20){f=(b_&c|(~b_&d))|0;k=0x5A827999;}else if(i<40){f=(b_^c^d)|0;k=0x6ED9EBA1;}else if(i<60){f=(b_&c|b_&d|c&d)|0;k=0x8F1BBCDC;}else{f=(b_^c^d)|0;k=0xCA62C1D6;}var t=(_rotl(a,5)+f+e+k+W[i])|0;e=d;d=c;c=_rotl(b_,30);b_=a;a=t;}
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b_)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;
  }
  var out=new Uint8Array(20);for(var i=0;i<5;i++)new DataView(out.buffer,i*4,4).setUint32(0,H[i]>>>0,false);return out;
}
function _hmac(hf,key,data){
  var k=_u8(key);if(k.length>64)k=hf(k);var kb=new Uint8Array(64);kb.set(k);
  var ip=new Uint8Array(64),op=new Uint8Array(64);for(var i=0;i<64;i++){ip[i]=kb[i]^0x36;op[i]=kb[i]^0x5C;}
  var dm=_u8(data),im=new Uint8Array(64+dm.length);im.set(ip);im.set(dm,64);
  var ih=hf(im),om=new Uint8Array(64+ih.length);om.set(op);om.set(ih,64);return hf(om);
}
function _concat(chunks){var l=0;for(var i=0;i<chunks.length;i++)l+=chunks[i].length;var a=new Uint8Array(l),o=0;for(var i=0;i<chunks.length;i++){a.set(chunks[i],o);o+=chunks[i].length;}return a;}
function _tryBuffer(b){try{return require('buffer').Buffer.from(b);}catch(e){return b;}}
function Hash(alg){this._alg=alg.toLowerCase().replace(/-/g,'');this._chunks=[];}
Hash.prototype.update=function(d,enc){if(typeof d==='string'&&enc==='hex'){var b=[];for(var i=0;i<d.length;i+=2)b.push(parseInt(d.substr(i,2),16));d=new Uint8Array(b);}this._chunks.push(_u8(d));return this;};
Hash.prototype.digest=function(enc){var all=_concat(this._chunks);var hf=this._alg==='sha1'?_sha1:_sha256,h=hf(all);if(enc==='hex')return _hex(h);if(enc==='base64')return btoa(String.fromCharCode.apply(null,h));return _tryBuffer(h);};
Hash.prototype.copy=function(){var n=new Hash(this._alg);n._chunks=this._chunks.slice();return n;};
function Hmac(alg,key){this._alg=alg.toLowerCase().replace(/-/g,'');this._key=_u8(key);this._chunks=[];}
Hmac.prototype.update=Hash.prototype.update;
Hmac.prototype.digest=function(enc){var all=_concat(this._chunks);var hf=this._alg==='sha1'?_sha1:_sha256,h=_hmac(hf,this._key,all);if(enc==='hex')return _hex(h);if(enc==='base64')return btoa(String.fromCharCode.apply(null,h));return _tryBuffer(h);};
function randomBytes(n,cb){var buf=new Uint8Array(n);if(typeof globalThis.crypto!=='undefined'&&globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues(buf);else for(var i=0;i<n;i++)buf[i]=Math.floor(Math.random()*256);var r=_tryBuffer(buf);if(typeof cb==='function'){setTimeout(function(){cb(null,r);},0);}return r;}
function randomUUID(){if(typeof globalThis.crypto!=='undefined'&&typeof globalThis.crypto.randomUUID==='function')return globalThis.crypto.randomUUID();var b=new Uint8Array(16);if(typeof globalThis.crypto!=='undefined'&&globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues(b);else for(var i=0;i<16;i++)b[i]=Math.floor(Math.random()*256);b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;var h=_hex(b);return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function timingSafeEqual(a,b){var ab=_u8(a),bb=_u8(b);if(ab.length!==bb.length)throw new RangeError('Input buffers must have the same length');var r=0;for(var i=0;i<ab.length;i++)r|=ab[i]^bb[i];return r===0;}
function pbkdf2Sync(pw,salt,iter,keylen){var h=_hmac(_sha256,pw,_u8(salt));var out=new Uint8Array(keylen);out.set(h.slice(0,Math.min(keylen,h.length)));return _tryBuffer(out);}
module.exports={createHash:function(a){return new Hash(a);},createHmac:function(a,k){return new Hmac(a,k);},randomBytes:randomBytes,randomFillSync:function(b){if(typeof globalThis.crypto!=='undefined'&&globalThis.crypto.getRandomValues)globalThis.crypto.getRandomValues(b instanceof Uint8Array?b:new Uint8Array(b));return b;},randomUUID:randomUUID,timingSafeEqual:timingSafeEqual,pbkdf2Sync:pbkdf2Sync,pbkdf2:function(pw,s,it,kl,dg,cb){if(typeof dg==='function'){cb=dg;}setTimeout(function(){cb(null,pbkdf2Sync(pw,s,it,kl));},0);},Hash:Hash,Hmac:Hmac,getHashes:function(){return['sha1','sha256','sha512','md5'];},getCiphers:function(){return[];},scryptSync:function(){throw new Error('crypto.scryptSync not supported in browser mode');},scrypt:function(pw,s,n,o,cb){if(typeof o==='function'){cb=o;}setTimeout(function(){cb(new Error('crypto.scrypt not supported in browser mode'));},0);}};
