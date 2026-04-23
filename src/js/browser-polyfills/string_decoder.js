function StringDecoder(enc){
  this.enc=(enc||'utf8').toLowerCase().replace(/[-_]/g,'');
  this._decoder=typeof TextDecoder!=='undefined'?new TextDecoder(this.enc==='utf8'?'utf-8':this.enc,{fatal:false,ignoreBOM:true}):null;
}
StringDecoder.prototype.write=function(buf){
  if(this._decoder)return this._decoder.decode(buf instanceof Uint8Array?buf:new Uint8Array(buf),{stream:true});
  var u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  return String.fromCharCode.apply(null,Array.from(u8));
};
StringDecoder.prototype.end=function(buf){
  var s=buf?this.write(buf):'';
  this._decoder=typeof TextDecoder!=='undefined'?new TextDecoder(this.enc==='utf8'?'utf-8':this.enc,{fatal:false,ignoreBOM:true}):null;
  return s;
};
StringDecoder.prototype.text=StringDecoder.prototype.write;
module.exports={StringDecoder:StringDecoder};
