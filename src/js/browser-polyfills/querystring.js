function qsEscape(s){
  return encodeURIComponent(String(s===null||s===undefined?'':s)).replace(/%20/g,'+').replace(/[!'()*]/g,function(c){return'%'+c.charCodeAt(0).toString(16).toUpperCase();});
}
function qsUnescape(s){
  try{return decodeURIComponent(String(s).replace(/\+/g,' '));}catch(e){return s;}
}
function stringify(obj,sep,eq,opts){
  sep=sep||'&';eq=eq||'=';
  if(!obj||typeof obj!=='object')return '';
  var enc=(opts&&opts.encodeURIComponent)||qsEscape;
  return Object.keys(obj).map(function(k){
    var v=obj[k];
    if(Array.isArray(v))return v.map(function(vi){return enc(k)+eq+enc(vi===null||vi===undefined?'':vi);}).join(sep);
    return enc(k)+eq+enc(v===null||v===undefined?'':v);
  }).join(sep);
}
function parse(str,sep,eq,opts){
  sep=sep||'&';eq=eq||'=';
  var maxKeys=(opts&&opts.maxKeys)||1000;
  var dec=(opts&&opts.decodeURIComponent)||qsUnescape;
  var r=Object.create(null);
  if(!str)return r;
  var pairs=String(str).split(sep);
  if(maxKeys>0&&pairs.length>maxKeys)pairs=pairs.slice(0,maxKeys);
  pairs.forEach(function(p){
    var idx=p.indexOf(eq);
    var k=idx<0?p:p.slice(0,idx);
    var v=idx<0?'':p.slice(idx+1);
    k=dec(k);v=dec(v);
    if(k in r){if(Array.isArray(r[k]))r[k].push(v);else r[k]=[r[k],v];}
    else r[k]=v;
  });
  return r;
}
module.exports={stringify:stringify,parse:parse,encode:stringify,decode:parse,escape:qsEscape,unescape:qsUnescape};
