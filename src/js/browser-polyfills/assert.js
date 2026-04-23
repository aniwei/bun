function AssertionError(msg,actual,expected){
  this.name='AssertionError';
  this.message=msg||'Assertion failed';
  this.actual=actual;this.expected=expected;
  if(Error.captureStackTrace)Error.captureStackTrace(this,AssertionError);
}
AssertionError.prototype=Object.create(Error.prototype,{constructor:{value:AssertionError,writable:true,configurable:true}});
function assert(val,msg){if(!val)throw new AssertionError(typeof msg==='string'?msg:msg instanceof Error?msg.message:'Assertion failed',val,true);}
assert.ok=assert;
assert.fail=function(msg){throw new AssertionError(msg||'assert.fail()');};
assert.strictEqual=function(a,b,msg){if(a!==b)throw new AssertionError(msg||(a+' !== '+b),a,b);};
assert.notStrictEqual=function(a,b,msg){if(a===b)throw new AssertionError(msg||'Expected values to differ',a,b);};
assert.deepStrictEqual=function(a,b,msg){if(JSON.stringify(a)!==JSON.stringify(b))throw new AssertionError(msg||'Deep equal failed',a,b);};
assert.notDeepStrictEqual=function(a,b,msg){if(JSON.stringify(a)===JSON.stringify(b))throw new AssertionError(msg||'Values are deeply equal',a,b);};
assert.equal=function(a,b,msg){if(a!=b)throw new AssertionError(msg||(a+' != '+b),a,b);};
assert.notEqual=function(a,b,msg){if(a==b)throw new AssertionError(msg||'Expected not equal',a,b);};
assert.throws=function(fn,expected,msg){var threw=false,err=null;try{fn();}catch(e){threw=true;err=e;}if(!threw)throw new AssertionError(msg||'Missing expected exception');if(expected instanceof RegExp&&!expected.test(err.message))throw new AssertionError(msg||'Wrong error: '+err.message);};
assert.doesNotThrow=function(fn,expected,msg){try{fn();}catch(e){throw new AssertionError(msg||('Got unwanted exception: '+(e&&e.message||e)));}};
assert.rejects=function(p,expected,msg){return Promise.resolve(typeof p==='function'?p():p).then(function(){throw new AssertionError(msg||'Missing expected rejection');},function(e){if(expected instanceof RegExp&&!expected.test(e.message))throw new AssertionError(msg||'Wrong rejection: '+e.message);});};
assert.doesNotReject=function(p){return Promise.resolve(typeof p==='function'?p():p);};
assert.match=function(s,re,msg){if(!re.test(s))throw new AssertionError(msg||(s+' does not match '+re));};
assert.doesNotMatch=function(s,re,msg){if(re.test(s))throw new AssertionError(msg||(s+' matches '+re));};
assert.ifError=function(e){if(e!=null)throw e;};
assert.AssertionError=AssertionError;
module.exports=assert;
