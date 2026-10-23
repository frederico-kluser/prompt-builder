"use strict";(()=>{var z0=Object.create;var sd=Object.defineProperty;var O0=Object.getOwnPropertyDescriptor;var B0=Object.getOwnPropertyNames;var M0=Object.getPrototypeOf,F0=Object.prototype.hasOwnProperty;var Ht=(e,t)=>()=>{try{return t||e((t={exports:{}}).exports,t),t.exports}catch(n){throw t=0,n}};var j0=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of B0(t))!F0.call(e,o)&&o!==n&&sd(e,o,{get:()=>t[o],enumerable:!(r=O0(t,o))||r.enumerable});return e};var D=(e,t,n)=>(n=e!=null?z0(M0(e)):{},j0(t||!e||!e.__esModule?sd(n,"default",{value:e,enumerable:!0}):n,e));var xd=Ht(F=>{"use strict";/**
 * @license React
 * react.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var Ro=Symbol.for("react.element"),V0=Symbol.for("react.portal"),H0=Symbol.for("react.fragment"),W0=Symbol.for("react.strict_mode"),U0=Symbol.for("react.profiler"),Q0=Symbol.for("react.provider"),G0=Symbol.for("react.context"),K0=Symbol.for("react.forward_ref"),Y0=Symbol.for("react.suspense"),X0=Symbol.for("react.memo"),Z0=Symbol.for("react.lazy"),ad=Symbol.iterator;function q0(e){return e===null||typeof e!="object"?null:(e=ad&&e[ad]||e["@@iterator"],typeof e=="function"?e:null)}var dd={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},fd=Object.assign,pd={};function Pr(e,t,n){this.props=e,this.context=t,this.refs=pd,this.updater=n||dd}Pr.prototype.isReactComponent={};Pr.prototype.setState=function(e,t){if(typeof e!="object"&&typeof e!="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};Pr.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};function md(){}md.prototype=Pr.prototype;function na(e,t,n){this.props=e,this.context=t,this.refs=pd,this.updater=n||dd}var ra=na.prototype=new md;ra.constructor=na;fd(ra,Pr.prototype);ra.isPureReactComponent=!0;var ud=Array.isArray,hd=Object.prototype.hasOwnProperty,oa={current:null},gd={key:!0,ref:!0,__self:!0,__source:!0};function yd(e,t,n){var r,o={},l=null,i=null;if(t!=null)for(r in t.ref!==void 0&&(i=t.ref),t.key!==void 0&&(l=""+t.key),t)hd.call(t,r)&&!gd.hasOwnProperty(r)&&(o[r]=t[r]);var s=arguments.length-2;if(s===1)o.children=n;else if(1<s){for(var a=Array(s),c=0;c<s;c++)a[c]=arguments[c+2];o.children=a}if(e&&e.defaultProps)for(r in s=e.defaultProps,s)o[r]===void 0&&(o[r]=s[r]);return{$$typeof:Ro,type:e,key:l,ref:i,props:o,_owner:oa.current}}function J0(e,t){return{$$typeof:Ro,type:e.type,key:t,ref:e.ref,props:e.props,_owner:e._owner}}function la(e){return typeof e=="object"&&e!==null&&e.$$typeof===Ro}function eg(e){var t={"=":"=0",":":"=2"};return"$"+e.replace(/[=:]/g,function(n){return t[n]})}var cd=/\/+/g;function ta(e,t){return typeof e=="object"&&e!==null&&e.key!=null?eg(""+e.key):t.toString(36)}function Yl(e,t,n,r,o){var l=typeof e;(l==="undefined"||l==="boolean")&&(e=null);var i=!1;if(e===null)i=!0;else switch(l){case"string":case"number":i=!0;break;case"object":switch(e.$$typeof){case Ro:case V0:i=!0}}if(i)return i=e,o=o(i),e=r===""?"."+ta(i,0):r,ud(o)?(n="",e!=null&&(n=e.replace(cd,"$&/")+"/"),Yl(o,t,n,"",function(c){return c})):o!=null&&(la(o)&&(o=J0(o,n+(!o.key||i&&i.key===o.key?"":(""+o.key).replace(cd,"$&/")+"/")+e)),t.push(o)),1;if(i=0,r=r===""?".":r+":",ud(e))for(var s=0;s<e.length;s++){l=e[s];var a=r+ta(l,s);i+=Yl(l,t,n,a,o)}else if(a=q0(e),typeof a=="function")for(e=a.call(e),s=0;!(l=e.next()).done;)l=l.value,a=r+ta(l,s++),i+=Yl(l,t,n,a,o);else if(l==="object")throw t=String(e),Error("Objects are not valid as a React child (found: "+(t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)+"). If you meant to render a collection of children, use an array instead.");return i}function Kl(e,t,n){if(e==null)return e;var r=[],o=0;return Yl(e,r,"","",function(l){return t.call(n,l,o++)}),r}function tg(e){if(e._status===-1){var t=e._result;t=t(),t.then(function(n){(e._status===0||e._status===-1)&&(e._status=1,e._result=n)},function(n){(e._status===0||e._status===-1)&&(e._status=2,e._result=n)}),e._status===-1&&(e._status=0,e._result=t)}if(e._status===1)return e._result.default;throw e._result}var Ze={current:null},Xl={transition:null},ng={ReactCurrentDispatcher:Ze,ReactCurrentBatchConfig:Xl,ReactCurrentOwner:oa};function vd(){throw Error("act(...) is not supported in production builds of React.")}F.Children={map:Kl,forEach:function(e,t,n){Kl(e,function(){t.apply(this,arguments)},n)},count:function(e){var t=0;return Kl(e,function(){t++}),t},toArray:function(e){return Kl(e,function(t){return t})||[]},only:function(e){if(!la(e))throw Error("React.Children.only expected to receive a single React element child.");return e}};F.Component=Pr;F.Fragment=H0;F.Profiler=U0;F.PureComponent=na;F.StrictMode=W0;F.Suspense=Y0;F.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=ng;F.act=vd;F.cloneElement=function(e,t,n){if(e==null)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+e+".");var r=fd({},e.props),o=e.key,l=e.ref,i=e._owner;if(t!=null){if(t.ref!==void 0&&(l=t.ref,i=oa.current),t.key!==void 0&&(o=""+t.key),e.type&&e.type.defaultProps)var s=e.type.defaultProps;for(a in t)hd.call(t,a)&&!gd.hasOwnProperty(a)&&(r[a]=t[a]===void 0&&s!==void 0?s[a]:t[a])}var a=arguments.length-2;if(a===1)r.children=n;else if(1<a){s=Array(a);for(var c=0;c<a;c++)s[c]=arguments[c+2];r.children=s}return{$$typeof:Ro,type:e.type,key:o,ref:l,props:r,_owner:i}};F.createContext=function(e){return e={$$typeof:G0,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:Q0,_context:e},e.Consumer=e};F.createElement=yd;F.createFactory=function(e){var t=yd.bind(null,e);return t.type=e,t};F.createRef=function(){return{current:null}};F.forwardRef=function(e){return{$$typeof:K0,render:e}};F.isValidElement=la;F.lazy=function(e){return{$$typeof:Z0,_payload:{_status:-1,_result:e},_init:tg}};F.memo=function(e,t){return{$$typeof:X0,type:e,compare:t===void 0?null:t}};F.startTransition=function(e){var t=Xl.transition;Xl.transition={};try{e()}finally{Xl.transition=t}};F.unstable_act=vd;F.useCallback=function(e,t){return Ze.current.useCallback(e,t)};F.useContext=function(e){return Ze.current.useContext(e)};F.useDebugValue=function(){};F.useDeferredValue=function(e){return Ze.current.useDeferredValue(e)};F.useEffect=function(e,t){return Ze.current.useEffect(e,t)};F.useId=function(){return Ze.current.useId()};F.useImperativeHandle=function(e,t,n){return Ze.current.useImperativeHandle(e,t,n)};F.useInsertionEffect=function(e,t){return Ze.current.useInsertionEffect(e,t)};F.useLayoutEffect=function(e,t){return Ze.current.useLayoutEffect(e,t)};F.useMemo=function(e,t){return Ze.current.useMemo(e,t)};F.useReducer=function(e,t,n){return Ze.current.useReducer(e,t,n)};F.useRef=function(e){return Ze.current.useRef(e)};F.useState=function(e){return Ze.current.useState(e)};F.useSyncExternalStore=function(e,t,n){return Ze.current.useSyncExternalStore(e,t,n)};F.useTransition=function(){return Ze.current.useTransition()};F.version="18.3.1"});var L=Ht((aw,wd)=>{"use strict";wd.exports=xd()});var _d=Ht(ne=>{"use strict";/**
 * @license React
 * scheduler.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */function ua(e,t){var n=e.length;e.push(t);e:for(;0<n;){var r=n-1>>>1,o=e[r];if(0<Zl(o,t))e[r]=t,e[n]=o,n=r;else break e}}function It(e){return e.length===0?null:e[0]}function Jl(e){if(e.length===0)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;e:for(var r=0,o=e.length,l=o>>>1;r<l;){var i=2*(r+1)-1,s=e[i],a=i+1,c=e[a];if(0>Zl(s,n))a<o&&0>Zl(c,s)?(e[r]=c,e[a]=n,r=a):(e[r]=s,e[i]=n,r=i);else if(a<o&&0>Zl(c,n))e[r]=c,e[a]=n,r=a;else break e}}return t}function Zl(e,t){var n=e.sortIndex-t.sortIndex;return n!==0?n:e.id-t.id}typeof performance=="object"&&typeof performance.now=="function"?(kd=performance,ne.unstable_now=function(){return kd.now()}):(ia=Date,Sd=ia.now(),ne.unstable_now=function(){return ia.now()-Sd});var kd,ia,Sd,Wt=[],En=[],rg=1,kt=null,We=3,ei=!1,sr=!1,No=!1,Ad=typeof setTimeout=="function"?setTimeout:null,Cd=typeof clearTimeout=="function"?clearTimeout:null,bd=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function ca(e){for(var t=It(En);t!==null;){if(t.callback===null)Jl(En);else if(t.startTime<=e)Jl(En),t.sortIndex=t.expirationTime,ua(Wt,t);else break;t=It(En)}}function da(e){if(No=!1,ca(e),!sr)if(It(Wt)!==null)sr=!0,pa(fa);else{var t=It(En);t!==null&&ma(da,t.startTime-e)}}function fa(e,t){sr=!1,No&&(No=!1,Cd(Io),Io=-1),ei=!0;var n=We;try{for(ca(t),kt=It(Wt);kt!==null&&(!(kt.expirationTime>t)||e&&!Rd());){var r=kt.callback;if(typeof r=="function"){kt.callback=null,We=kt.priorityLevel;var o=r(kt.expirationTime<=t);t=ne.unstable_now(),typeof o=="function"?kt.callback=o:kt===It(Wt)&&Jl(Wt),ca(t)}else Jl(Wt);kt=It(Wt)}if(kt!==null)var l=!0;else{var i=It(En);i!==null&&ma(da,i.startTime-t),l=!1}return l}finally{kt=null,We=n,ei=!1}}var ti=!1,ql=null,Io=-1,Td=5,$d=-1;function Rd(){return!(ne.unstable_now()-$d<Td)}function sa(){if(ql!==null){var e=ne.unstable_now();$d=e;var t=!0;try{t=ql(!0,e)}finally{t?_o():(ti=!1,ql=null)}}else ti=!1}var _o;typeof bd=="function"?_o=function(){bd(sa)}:typeof MessageChannel<"u"?(aa=new MessageChannel,Ed=aa.port2,aa.port1.onmessage=sa,_o=function(){Ed.postMessage(null)}):_o=function(){Ad(sa,0)};var aa,Ed;function pa(e){ql=e,ti||(ti=!0,_o())}function ma(e,t){Io=Ad(function(){e(ne.unstable_now())},t)}ne.unstable_IdlePriority=5;ne.unstable_ImmediatePriority=1;ne.unstable_LowPriority=4;ne.unstable_NormalPriority=3;ne.unstable_Profiling=null;ne.unstable_UserBlockingPriority=2;ne.unstable_cancelCallback=function(e){e.callback=null};ne.unstable_continueExecution=function(){sr||ei||(sr=!0,pa(fa))};ne.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Td=0<e?Math.floor(1e3/e):5};ne.unstable_getCurrentPriorityLevel=function(){return We};ne.unstable_getFirstCallbackNode=function(){return It(Wt)};ne.unstable_next=function(e){switch(We){case 1:case 2:case 3:var t=3;break;default:t=We}var n=We;We=t;try{return e()}finally{We=n}};ne.unstable_pauseExecution=function(){};ne.unstable_requestPaint=function(){};ne.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=We;We=e;try{return t()}finally{We=n}};ne.unstable_scheduleCallback=function(e,t,n){var r=ne.unstable_now();switch(typeof n=="object"&&n!==null?(n=n.delay,n=typeof n=="number"&&0<n?r+n:r):n=r,e){case 1:var o=-1;break;case 2:o=250;break;case 5:o=1073741823;break;case 4:o=1e4;break;default:o=5e3}return o=n+o,e={id:rg++,callback:t,priorityLevel:e,startTime:n,expirationTime:o,sortIndex:-1},n>r?(e.sortIndex=n,ua(En,e),It(Wt)===null&&e===It(En)&&(No?(Cd(Io),Io=-1):No=!0,ma(da,n-r))):(e.sortIndex=o,ua(Wt,e),sr||ei||(sr=!0,pa(fa))),e};ne.unstable_shouldYield=Rd;ne.unstable_wrapCallback=function(e){var t=We;return function(){var n=We;We=t;try{return e.apply(this,arguments)}finally{We=n}}}});var Id=Ht((cw,Nd)=>{"use strict";Nd.exports=_d()});var Om=Ht(vt=>{"use strict";/**
 * @license React
 * react-dom.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var og=L(),gt=Id();function C(e){for(var t="https://reactjs.org/docs/error-decoder.html?invariant="+e,n=1;n<arguments.length;n++)t+="&args[]="+encodeURIComponent(arguments[n]);return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}var Ff=new Set,el={};function wr(e,t){to(e,t),to(e+"Capture",t)}function to(e,t){for(el[e]=t,e=0;e<t.length;e++)Ff.add(t[e])}var an=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),Oa=Object.prototype.hasOwnProperty,lg=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Dd={},Pd={};function ig(e){return Oa.call(Pd,e)?!0:Oa.call(Dd,e)?!1:lg.test(e)?Pd[e]=!0:(Dd[e]=!0,!1)}function sg(e,t,n,r){if(n!==null&&n.type===0)return!1;switch(typeof t){case"function":case"symbol":return!0;case"boolean":return r?!1:n!==null?!n.acceptsBooleans:(e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-");default:return!1}}function ag(e,t,n,r){if(t===null||typeof t>"u"||sg(e,t,n,r))return!0;if(r)return!1;if(n!==null)switch(n.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function et(e,t,n,r,o,l,i){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=r,this.attributeNamespace=o,this.mustUseProperty=n,this.propertyName=e,this.type=t,this.sanitizeURL=l,this.removeEmptyString=i}var je={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){je[e]=new et(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var t=e[0];je[t]=new et(t,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){je[e]=new et(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){je[e]=new et(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){je[e]=new et(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){je[e]=new et(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){je[e]=new et(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){je[e]=new et(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){je[e]=new et(e,5,!1,e.toLowerCase(),null,!1,!1)});var Ru=/[\-:]([a-z])/g;function _u(e){return e[1].toUpperCase()}"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var t=e.replace(Ru,_u);je[t]=new et(t,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var t=e.replace(Ru,_u);je[t]=new et(t,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var t=e.replace(Ru,_u);je[t]=new et(t,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){je[e]=new et(e,1,!1,e.toLowerCase(),null,!1,!1)});je.xlinkHref=new et("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){je[e]=new et(e,1,!1,e.toLowerCase(),null,!0,!0)});function Nu(e,t,n,r){var o=je.hasOwnProperty(t)?je[t]:null;(o!==null?o.type!==0:r||!(2<t.length)||t[0]!=="o"&&t[0]!=="O"||t[1]!=="n"&&t[1]!=="N")&&(ag(t,n,o,r)&&(n=null),r||o===null?ig(t)&&(n===null?e.removeAttribute(t):e.setAttribute(t,""+n)):o.mustUseProperty?e[o.propertyName]=n===null?o.type===3?!1:"":n:(t=o.attributeName,r=o.attributeNamespace,n===null?e.removeAttribute(t):(o=o.type,n=o===3||o===4&&n===!0?"":""+n,r?e.setAttributeNS(r,t,n):e.setAttribute(t,n))))}var fn=og.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,ni=Symbol.for("react.element"),Or=Symbol.for("react.portal"),Br=Symbol.for("react.fragment"),Iu=Symbol.for("react.strict_mode"),Ba=Symbol.for("react.profiler"),jf=Symbol.for("react.provider"),Vf=Symbol.for("react.context"),Du=Symbol.for("react.forward_ref"),Ma=Symbol.for("react.suspense"),Fa=Symbol.for("react.suspense_list"),Pu=Symbol.for("react.memo"),Cn=Symbol.for("react.lazy"),Hf=Symbol.for("react.offscreen"),Ld=Symbol.iterator;function Do(e){return e===null||typeof e!="object"?null:(e=Ld&&e[Ld]||e["@@iterator"],typeof e=="function"?e:null)}var me=Object.assign,ha;function jo(e){if(ha===void 0)try{throw Error()}catch(n){var t=n.stack.trim().match(/\n( *(at )?)/);ha=t&&t[1]||""}return`
`+ha+e}var ga=!1;function ya(e,t){if(!e||ga)return"";ga=!0;var n=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(t,[])}catch(c){var r=c}Reflect.construct(e,[],t)}else{try{t.call()}catch(c){r=c}e.call(t.prototype)}else{try{throw Error()}catch(c){r=c}e()}}catch(c){if(c&&r&&typeof c.stack=="string"){for(var o=c.stack.split(`
`),l=r.stack.split(`
`),i=o.length-1,s=l.length-1;1<=i&&0<=s&&o[i]!==l[s];)s--;for(;1<=i&&0<=s;i--,s--)if(o[i]!==l[s]){if(i!==1||s!==1)do if(i--,s--,0>s||o[i]!==l[s]){var a=`
`+o[i].replace(" at new "," at ");return e.displayName&&a.includes("<anonymous>")&&(a=a.replace("<anonymous>",e.displayName)),a}while(1<=i&&0<=s);break}}}finally{ga=!1,Error.prepareStackTrace=n}return(e=e?e.displayName||e.name:"")?jo(e):""}function ug(e){switch(e.tag){case 5:return jo(e.type);case 16:return jo("Lazy");case 13:return jo("Suspense");case 19:return jo("SuspenseList");case 0:case 2:case 15:return e=ya(e.type,!1),e;case 11:return e=ya(e.type.render,!1),e;case 1:return e=ya(e.type,!0),e;default:return""}}function ja(e){if(e==null)return null;if(typeof e=="function")return e.displayName||e.name||null;if(typeof e=="string")return e;switch(e){case Br:return"Fragment";case Or:return"Portal";case Ba:return"Profiler";case Iu:return"StrictMode";case Ma:return"Suspense";case Fa:return"SuspenseList"}if(typeof e=="object")switch(e.$$typeof){case Vf:return(e.displayName||"Context")+".Consumer";case jf:return(e._context.displayName||"Context")+".Provider";case Du:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Pu:return t=e.displayName||null,t!==null?t:ja(e.type)||"Memo";case Cn:t=e._payload,e=e._init;try{return ja(e(t))}catch{}}return null}function cg(e){var t=e.type;switch(e.tag){case 24:return"Cache";case 9:return(t.displayName||"Context")+".Consumer";case 10:return(t._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=t.render,e=e.displayName||e.name||"",t.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return t;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return ja(t);case 8:return t===Iu?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t=="function")return t.displayName||t.name||null;if(typeof t=="string")return t}return null}function Fn(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Wf(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function dg(e){var t=Wf(e)?"checked":"value",n=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),r=""+e[t];if(!e.hasOwnProperty(t)&&typeof n<"u"&&typeof n.get=="function"&&typeof n.set=="function"){var o=n.get,l=n.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return o.call(this)},set:function(i){r=""+i,l.call(this,i)}}),Object.defineProperty(e,t,{enumerable:n.enumerable}),{getValue:function(){return r},setValue:function(i){r=""+i},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function ri(e){e._valueTracker||(e._valueTracker=dg(e))}function Uf(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var n=t.getValue(),r="";return e&&(r=Wf(e)?e.checked?"true":"false":e.value),e=r,e!==n?(t.setValue(e),!0):!1}function Ni(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch{return e.body}}function Va(e,t){var n=t.checked;return me({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:n??e._wrapperState.initialChecked})}function zd(e,t){var n=t.defaultValue==null?"":t.defaultValue,r=t.checked!=null?t.checked:t.defaultChecked;n=Fn(t.value!=null?t.value:n),e._wrapperState={initialChecked:r,initialValue:n,controlled:t.type==="checkbox"||t.type==="radio"?t.checked!=null:t.value!=null}}function Qf(e,t){t=t.checked,t!=null&&Nu(e,"checked",t,!1)}function Ha(e,t){Qf(e,t);var n=Fn(t.value),r=t.type;if(n!=null)r==="number"?(n===0&&e.value===""||e.value!=n)&&(e.value=""+n):e.value!==""+n&&(e.value=""+n);else if(r==="submit"||r==="reset"){e.removeAttribute("value");return}t.hasOwnProperty("value")?Wa(e,t.type,n):t.hasOwnProperty("defaultValue")&&Wa(e,t.type,Fn(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function Od(e,t,n){if(t.hasOwnProperty("value")||t.hasOwnProperty("defaultValue")){var r=t.type;if(!(r!=="submit"&&r!=="reset"||t.value!==void 0&&t.value!==null))return;t=""+e._wrapperState.initialValue,n||t===e.value||(e.value=t),e.defaultValue=t}n=e.name,n!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,n!==""&&(e.name=n)}function Wa(e,t,n){(t!=="number"||Ni(e.ownerDocument)!==e)&&(n==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+n&&(e.defaultValue=""+n))}var Vo=Array.isArray;function Yr(e,t,n,r){if(e=e.options,t){t={};for(var o=0;o<n.length;o++)t["$"+n[o]]=!0;for(n=0;n<e.length;n++)o=t.hasOwnProperty("$"+e[n].value),e[n].selected!==o&&(e[n].selected=o),o&&r&&(e[n].defaultSelected=!0)}else{for(n=""+Fn(n),t=null,o=0;o<e.length;o++){if(e[o].value===n){e[o].selected=!0,r&&(e[o].defaultSelected=!0);return}t!==null||e[o].disabled||(t=e[o])}t!==null&&(t.selected=!0)}}function Ua(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(C(91));return me({},t,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function Bd(e,t){var n=t.value;if(n==null){if(n=t.children,t=t.defaultValue,n!=null){if(t!=null)throw Error(C(92));if(Vo(n)){if(1<n.length)throw Error(C(93));n=n[0]}t=n}t==null&&(t=""),n=t}e._wrapperState={initialValue:Fn(n)}}function Gf(e,t){var n=Fn(t.value),r=Fn(t.defaultValue);n!=null&&(n=""+n,n!==e.value&&(e.value=n),t.defaultValue==null&&e.defaultValue!==n&&(e.defaultValue=n)),r!=null&&(e.defaultValue=""+r)}function Md(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==""&&t!==null&&(e.value=t)}function Kf(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Qa(e,t){return e==null||e==="http://www.w3.org/1999/xhtml"?Kf(t):e==="http://www.w3.org/2000/svg"&&t==="foreignObject"?"http://www.w3.org/1999/xhtml":e}var oi,Yf=(function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(t,n,r,o){MSApp.execUnsafeLocalFunction(function(){return e(t,n,r,o)})}:e})(function(e,t){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=t;else{for(oi=oi||document.createElement("div"),oi.innerHTML="<svg>"+t.valueOf().toString()+"</svg>",t=oi.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});function tl(e,t){if(t){var n=e.firstChild;if(n&&n===e.lastChild&&n.nodeType===3){n.nodeValue=t;return}}e.textContent=t}var Uo={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},fg=["Webkit","ms","Moz","O"];Object.keys(Uo).forEach(function(e){fg.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),Uo[t]=Uo[e]})});function Xf(e,t,n){return t==null||typeof t=="boolean"||t===""?"":n||typeof t!="number"||t===0||Uo.hasOwnProperty(e)&&Uo[e]?(""+t).trim():t+"px"}function Zf(e,t){e=e.style;for(var n in t)if(t.hasOwnProperty(n)){var r=n.indexOf("--")===0,o=Xf(n,t[n],r);n==="float"&&(n="cssFloat"),r?e.setProperty(n,o):e[n]=o}}var pg=me({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});function Ga(e,t){if(t){if(pg[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(C(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(C(60));if(typeof t.dangerouslySetInnerHTML!="object"||!("__html"in t.dangerouslySetInnerHTML))throw Error(C(61))}if(t.style!=null&&typeof t.style!="object")throw Error(C(62))}}function Ka(e,t){if(e.indexOf("-")===-1)return typeof t.is=="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var Ya=null;function Lu(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var Xa=null,Xr=null,Zr=null;function Fd(e){if(e=xl(e)){if(typeof Xa!="function")throw Error(C(280));var t=e.stateNode;t&&(t=ls(t),Xa(e.stateNode,e.type,t))}}function qf(e){Xr?Zr?Zr.push(e):Zr=[e]:Xr=e}function Jf(){if(Xr){var e=Xr,t=Zr;if(Zr=Xr=null,Fd(e),t)for(e=0;e<t.length;e++)Fd(t[e])}}function ep(e,t){return e(t)}function tp(){}var va=!1;function np(e,t,n){if(va)return e(t,n);va=!0;try{return ep(e,t,n)}finally{va=!1,(Xr!==null||Zr!==null)&&(tp(),Jf())}}function nl(e,t){var n=e.stateNode;if(n===null)return null;var r=ls(n);if(r===null)return null;n=r[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(r=!r.disabled)||(e=e.type,r=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!r;break e;default:e=!1}if(e)return null;if(n&&typeof n!="function")throw Error(C(231,t,typeof n));return n}var Za=!1;if(an)try{Lr={},Object.defineProperty(Lr,"passive",{get:function(){Za=!0}}),window.addEventListener("test",Lr,Lr),window.removeEventListener("test",Lr,Lr)}catch{Za=!1}var Lr;function mg(e,t,n,r,o,l,i,s,a){var c=Array.prototype.slice.call(arguments,3);try{t.apply(n,c)}catch(h){this.onError(h)}}var Qo=!1,Ii=null,Di=!1,qa=null,hg={onError:function(e){Qo=!0,Ii=e}};function gg(e,t,n,r,o,l,i,s,a){Qo=!1,Ii=null,mg.apply(hg,arguments)}function yg(e,t,n,r,o,l,i,s,a){if(gg.apply(this,arguments),Qo){if(Qo){var c=Ii;Qo=!1,Ii=null}else throw Error(C(198));Di||(Di=!0,qa=c)}}function kr(e){var t=e,n=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(n=t.return),e=t.return;while(e)}return t.tag===3?n:null}function rp(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function jd(e){if(kr(e)!==e)throw Error(C(188))}function vg(e){var t=e.alternate;if(!t){if(t=kr(e),t===null)throw Error(C(188));return t!==e?null:e}for(var n=e,r=t;;){var o=n.return;if(o===null)break;var l=o.alternate;if(l===null){if(r=o.return,r!==null){n=r;continue}break}if(o.child===l.child){for(l=o.child;l;){if(l===n)return jd(o),e;if(l===r)return jd(o),t;l=l.sibling}throw Error(C(188))}if(n.return!==r.return)n=o,r=l;else{for(var i=!1,s=o.child;s;){if(s===n){i=!0,n=o,r=l;break}if(s===r){i=!0,r=o,n=l;break}s=s.sibling}if(!i){for(s=l.child;s;){if(s===n){i=!0,n=l,r=o;break}if(s===r){i=!0,r=l,n=o;break}s=s.sibling}if(!i)throw Error(C(189))}}if(n.alternate!==r)throw Error(C(190))}if(n.tag!==3)throw Error(C(188));return n.stateNode.current===n?e:t}function op(e){return e=vg(e),e!==null?lp(e):null}function lp(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=lp(e);if(t!==null)return t;e=e.sibling}return null}var ip=gt.unstable_scheduleCallback,Vd=gt.unstable_cancelCallback,xg=gt.unstable_shouldYield,wg=gt.unstable_requestPaint,we=gt.unstable_now,kg=gt.unstable_getCurrentPriorityLevel,zu=gt.unstable_ImmediatePriority,sp=gt.unstable_UserBlockingPriority,Pi=gt.unstable_NormalPriority,Sg=gt.unstable_LowPriority,ap=gt.unstable_IdlePriority,ts=null,Kt=null;function bg(e){if(Kt&&typeof Kt.onCommitFiberRoot=="function")try{Kt.onCommitFiberRoot(ts,e,void 0,(e.current.flags&128)===128)}catch{}}var Ot=Math.clz32?Math.clz32:Cg,Eg=Math.log,Ag=Math.LN2;function Cg(e){return e>>>=0,e===0?32:31-(Eg(e)/Ag|0)|0}var li=64,ii=4194304;function Ho(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Li(e,t){var n=e.pendingLanes;if(n===0)return 0;var r=0,o=e.suspendedLanes,l=e.pingedLanes,i=n&268435455;if(i!==0){var s=i&~o;s!==0?r=Ho(s):(l&=i,l!==0&&(r=Ho(l)))}else i=n&~o,i!==0?r=Ho(i):l!==0&&(r=Ho(l));if(r===0)return 0;if(t!==0&&t!==r&&(t&o)===0&&(o=r&-r,l=t&-t,o>=l||o===16&&(l&4194240)!==0))return t;if((r&4)!==0&&(r|=n&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=r;0<t;)n=31-Ot(t),o=1<<n,r|=e[n],t&=~o;return r}function Tg(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function $g(e,t){for(var n=e.suspendedLanes,r=e.pingedLanes,o=e.expirationTimes,l=e.pendingLanes;0<l;){var i=31-Ot(l),s=1<<i,a=o[i];a===-1?((s&n)===0||(s&r)!==0)&&(o[i]=Tg(s,t)):a<=t&&(e.expiredLanes|=s),l&=~s}}function Ja(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function up(){var e=li;return li<<=1,(li&4194240)===0&&(li=64),e}function xa(e){for(var t=[],n=0;31>n;n++)t.push(e);return t}function yl(e,t,n){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-Ot(t),e[t]=n}function Rg(e,t){var n=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var r=e.eventTimes;for(e=e.expirationTimes;0<n;){var o=31-Ot(n),l=1<<o;t[o]=0,r[o]=-1,e[o]=-1,n&=~l}}function Ou(e,t){var n=e.entangledLanes|=t;for(e=e.entanglements;n;){var r=31-Ot(n),o=1<<r;o&t|e[r]&t&&(e[r]|=t),n&=~o}}var ee=0;function cp(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}var dp,Bu,fp,pp,mp,eu=!1,si=[],In=null,Dn=null,Pn=null,rl=new Map,ol=new Map,$n=[],_g="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");function Hd(e,t){switch(e){case"focusin":case"focusout":In=null;break;case"dragenter":case"dragleave":Dn=null;break;case"mouseover":case"mouseout":Pn=null;break;case"pointerover":case"pointerout":rl.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":ol.delete(t.pointerId)}}function Po(e,t,n,r,o,l){return e===null||e.nativeEvent!==l?(e={blockedOn:t,domEventName:n,eventSystemFlags:r,nativeEvent:l,targetContainers:[o]},t!==null&&(t=xl(t),t!==null&&Bu(t)),e):(e.eventSystemFlags|=r,t=e.targetContainers,o!==null&&t.indexOf(o)===-1&&t.push(o),e)}function Ng(e,t,n,r,o){switch(t){case"focusin":return In=Po(In,e,t,n,r,o),!0;case"dragenter":return Dn=Po(Dn,e,t,n,r,o),!0;case"mouseover":return Pn=Po(Pn,e,t,n,r,o),!0;case"pointerover":var l=o.pointerId;return rl.set(l,Po(rl.get(l)||null,e,t,n,r,o)),!0;case"gotpointercapture":return l=o.pointerId,ol.set(l,Po(ol.get(l)||null,e,t,n,r,o)),!0}return!1}function hp(e){var t=cr(e.target);if(t!==null){var n=kr(t);if(n!==null){if(t=n.tag,t===13){if(t=rp(n),t!==null){e.blockedOn=t,mp(e.priority,function(){fp(n)});return}}else if(t===3&&n.stateNode.current.memoizedState.isDehydrated){e.blockedOn=n.tag===3?n.stateNode.containerInfo:null;return}}}e.blockedOn=null}function ki(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var n=tu(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(n===null){n=e.nativeEvent;var r=new n.constructor(n.type,n);Ya=r,n.target.dispatchEvent(r),Ya=null}else return t=xl(n),t!==null&&Bu(t),e.blockedOn=n,!1;t.shift()}return!0}function Wd(e,t,n){ki(e)&&n.delete(t)}function Ig(){eu=!1,In!==null&&ki(In)&&(In=null),Dn!==null&&ki(Dn)&&(Dn=null),Pn!==null&&ki(Pn)&&(Pn=null),rl.forEach(Wd),ol.forEach(Wd)}function Lo(e,t){e.blockedOn===t&&(e.blockedOn=null,eu||(eu=!0,gt.unstable_scheduleCallback(gt.unstable_NormalPriority,Ig)))}function ll(e){function t(o){return Lo(o,e)}if(0<si.length){Lo(si[0],e);for(var n=1;n<si.length;n++){var r=si[n];r.blockedOn===e&&(r.blockedOn=null)}}for(In!==null&&Lo(In,e),Dn!==null&&Lo(Dn,e),Pn!==null&&Lo(Pn,e),rl.forEach(t),ol.forEach(t),n=0;n<$n.length;n++)r=$n[n],r.blockedOn===e&&(r.blockedOn=null);for(;0<$n.length&&(n=$n[0],n.blockedOn===null);)hp(n),n.blockedOn===null&&$n.shift()}var qr=fn.ReactCurrentBatchConfig,zi=!0;function Dg(e,t,n,r){var o=ee,l=qr.transition;qr.transition=null;try{ee=1,Mu(e,t,n,r)}finally{ee=o,qr.transition=l}}function Pg(e,t,n,r){var o=ee,l=qr.transition;qr.transition=null;try{ee=4,Mu(e,t,n,r)}finally{ee=o,qr.transition=l}}function Mu(e,t,n,r){if(zi){var o=tu(e,t,n,r);if(o===null)Ca(e,t,r,Oi,n),Hd(e,r);else if(Ng(o,e,t,n,r))r.stopPropagation();else if(Hd(e,r),t&4&&-1<_g.indexOf(e)){for(;o!==null;){var l=xl(o);if(l!==null&&dp(l),l=tu(e,t,n,r),l===null&&Ca(e,t,r,Oi,n),l===o)break;o=l}o!==null&&r.stopPropagation()}else Ca(e,t,r,null,n)}}var Oi=null;function tu(e,t,n,r){if(Oi=null,e=Lu(r),e=cr(e),e!==null)if(t=kr(e),t===null)e=null;else if(n=t.tag,n===13){if(e=rp(t),e!==null)return e;e=null}else if(n===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Oi=e,null}function gp(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(kg()){case zu:return 1;case sp:return 4;case Pi:case Sg:return 16;case ap:return 536870912;default:return 16}default:return 16}}var _n=null,Fu=null,Si=null;function yp(){if(Si)return Si;var e,t=Fu,n=t.length,r,o="value"in _n?_n.value:_n.textContent,l=o.length;for(e=0;e<n&&t[e]===o[e];e++);var i=n-e;for(r=1;r<=i&&t[n-r]===o[l-r];r++);return Si=o.slice(e,1<r?1-r:void 0)}function bi(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function ai(){return!0}function Ud(){return!1}function yt(e){function t(n,r,o,l,i){this._reactName=n,this._targetInst=o,this.type=r,this.nativeEvent=l,this.target=i,this.currentTarget=null;for(var s in e)e.hasOwnProperty(s)&&(n=e[s],this[s]=n?n(l):l[s]);return this.isDefaultPrevented=(l.defaultPrevented!=null?l.defaultPrevented:l.returnValue===!1)?ai:Ud,this.isPropagationStopped=Ud,this}return me(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var n=this.nativeEvent;n&&(n.preventDefault?n.preventDefault():typeof n.returnValue!="unknown"&&(n.returnValue=!1),this.isDefaultPrevented=ai)},stopPropagation:function(){var n=this.nativeEvent;n&&(n.stopPropagation?n.stopPropagation():typeof n.cancelBubble!="unknown"&&(n.cancelBubble=!0),this.isPropagationStopped=ai)},persist:function(){},isPersistent:ai}),t}var ao={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},ju=yt(ao),vl=me({},ao,{view:0,detail:0}),Lg=yt(vl),wa,ka,zo,ns=me({},vl,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Vu,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return"movementX"in e?e.movementX:(e!==zo&&(zo&&e.type==="mousemove"?(wa=e.screenX-zo.screenX,ka=e.screenY-zo.screenY):ka=wa=0,zo=e),wa)},movementY:function(e){return"movementY"in e?e.movementY:ka}}),Qd=yt(ns),zg=me({},ns,{dataTransfer:0}),Og=yt(zg),Bg=me({},vl,{relatedTarget:0}),Sa=yt(Bg),Mg=me({},ao,{animationName:0,elapsedTime:0,pseudoElement:0}),Fg=yt(Mg),jg=me({},ao,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),Vg=yt(jg),Hg=me({},ao,{data:0}),Gd=yt(Hg),Wg={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},Ug={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Qg={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function Gg(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=Qg[e])?!!t[e]:!1}function Vu(){return Gg}var Kg=me({},vl,{key:function(e){if(e.key){var t=Wg[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=bi(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?Ug[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Vu,charCode:function(e){return e.type==="keypress"?bi(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?bi(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),Yg=yt(Kg),Xg=me({},ns,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Kd=yt(Xg),Zg=me({},vl,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Vu}),qg=yt(Zg),Jg=me({},ao,{propertyName:0,elapsedTime:0,pseudoElement:0}),ey=yt(Jg),ty=me({},ns,{deltaX:function(e){return"deltaX"in e?e.deltaX:"wheelDeltaX"in e?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:"wheelDeltaY"in e?-e.wheelDeltaY:"wheelDelta"in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),ny=yt(ty),ry=[9,13,27,32],Hu=an&&"CompositionEvent"in window,Go=null;an&&"documentMode"in document&&(Go=document.documentMode);var oy=an&&"TextEvent"in window&&!Go,vp=an&&(!Hu||Go&&8<Go&&11>=Go),Yd=" ",Xd=!1;function xp(e,t){switch(e){case"keyup":return ry.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function wp(e){return e=e.detail,typeof e=="object"&&"data"in e?e.data:null}var Mr=!1;function ly(e,t){switch(e){case"compositionend":return wp(t);case"keypress":return t.which!==32?null:(Xd=!0,Yd);case"textInput":return e=t.data,e===Yd&&Xd?null:e;default:return null}}function iy(e,t){if(Mr)return e==="compositionend"||!Hu&&xp(e,t)?(e=yp(),Si=Fu=_n=null,Mr=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return vp&&t.locale!=="ko"?null:t.data;default:return null}}var sy={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function Zd(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!sy[e.type]:t==="textarea"}function kp(e,t,n,r){qf(r),t=Bi(t,"onChange"),0<t.length&&(n=new ju("onChange","change",null,n,r),e.push({event:n,listeners:t}))}var Ko=null,il=null;function ay(e){Ip(e,0)}function rs(e){var t=Vr(e);if(Uf(t))return e}function uy(e,t){if(e==="change")return t}var Sp=!1;an&&(an?(ci="oninput"in document,ci||(ba=document.createElement("div"),ba.setAttribute("oninput","return;"),ci=typeof ba.oninput=="function"),ui=ci):ui=!1,Sp=ui&&(!document.documentMode||9<document.documentMode));var ui,ci,ba;function qd(){Ko&&(Ko.detachEvent("onpropertychange",bp),il=Ko=null)}function bp(e){if(e.propertyName==="value"&&rs(il)){var t=[];kp(t,il,e,Lu(e)),np(ay,t)}}function cy(e,t,n){e==="focusin"?(qd(),Ko=t,il=n,Ko.attachEvent("onpropertychange",bp)):e==="focusout"&&qd()}function dy(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return rs(il)}function fy(e,t){if(e==="click")return rs(t)}function py(e,t){if(e==="input"||e==="change")return rs(t)}function my(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var Mt=typeof Object.is=="function"?Object.is:my;function sl(e,t){if(Mt(e,t))return!0;if(typeof e!="object"||e===null||typeof t!="object"||t===null)return!1;var n=Object.keys(e),r=Object.keys(t);if(n.length!==r.length)return!1;for(r=0;r<n.length;r++){var o=n[r];if(!Oa.call(t,o)||!Mt(e[o],t[o]))return!1}return!0}function Jd(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function ef(e,t){var n=Jd(e);e=0;for(var r;n;){if(n.nodeType===3){if(r=e+n.textContent.length,e<=t&&r>=t)return{node:n,offset:t-e};e=r}e:{for(;n;){if(n.nextSibling){n=n.nextSibling;break e}n=n.parentNode}n=void 0}n=Jd(n)}}function Ep(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?Ep(e,t.parentNode):"contains"in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function Ap(){for(var e=window,t=Ni();t instanceof e.HTMLIFrameElement;){try{var n=typeof t.contentWindow.location.href=="string"}catch{n=!1}if(n)e=t.contentWindow;else break;t=Ni(e.document)}return t}function Wu(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}function hy(e){var t=Ap(),n=e.focusedElem,r=e.selectionRange;if(t!==n&&n&&n.ownerDocument&&Ep(n.ownerDocument.documentElement,n)){if(r!==null&&Wu(n)){if(t=r.start,e=r.end,e===void 0&&(e=t),"selectionStart"in n)n.selectionStart=t,n.selectionEnd=Math.min(e,n.value.length);else if(e=(t=n.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var o=n.textContent.length,l=Math.min(r.start,o);r=r.end===void 0?l:Math.min(r.end,o),!e.extend&&l>r&&(o=r,r=l,l=o),o=ef(n,l);var i=ef(n,r);o&&i&&(e.rangeCount!==1||e.anchorNode!==o.node||e.anchorOffset!==o.offset||e.focusNode!==i.node||e.focusOffset!==i.offset)&&(t=t.createRange(),t.setStart(o.node,o.offset),e.removeAllRanges(),l>r?(e.addRange(t),e.extend(i.node,i.offset)):(t.setEnd(i.node,i.offset),e.addRange(t)))}}for(t=[],e=n;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});for(typeof n.focus=="function"&&n.focus(),n=0;n<t.length;n++)e=t[n],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}var gy=an&&"documentMode"in document&&11>=document.documentMode,Fr=null,nu=null,Yo=null,ru=!1;function tf(e,t,n){var r=n.window===n?n.document:n.nodeType===9?n:n.ownerDocument;ru||Fr==null||Fr!==Ni(r)||(r=Fr,"selectionStart"in r&&Wu(r)?r={start:r.selectionStart,end:r.selectionEnd}:(r=(r.ownerDocument&&r.ownerDocument.defaultView||window).getSelection(),r={anchorNode:r.anchorNode,anchorOffset:r.anchorOffset,focusNode:r.focusNode,focusOffset:r.focusOffset}),Yo&&sl(Yo,r)||(Yo=r,r=Bi(nu,"onSelect"),0<r.length&&(t=new ju("onSelect","select",null,t,n),e.push({event:t,listeners:r}),t.target=Fr)))}function di(e,t){var n={};return n[e.toLowerCase()]=t.toLowerCase(),n["Webkit"+e]="webkit"+t,n["Moz"+e]="moz"+t,n}var jr={animationend:di("Animation","AnimationEnd"),animationiteration:di("Animation","AnimationIteration"),animationstart:di("Animation","AnimationStart"),transitionend:di("Transition","TransitionEnd")},Ea={},Cp={};an&&(Cp=document.createElement("div").style,"AnimationEvent"in window||(delete jr.animationend.animation,delete jr.animationiteration.animation,delete jr.animationstart.animation),"TransitionEvent"in window||delete jr.transitionend.transition);function os(e){if(Ea[e])return Ea[e];if(!jr[e])return e;var t=jr[e],n;for(n in t)if(t.hasOwnProperty(n)&&n in Cp)return Ea[e]=t[n];return e}var Tp=os("animationend"),$p=os("animationiteration"),Rp=os("animationstart"),_p=os("transitionend"),Np=new Map,nf="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");function Vn(e,t){Np.set(e,t),wr(t,[e])}for(fi=0;fi<nf.length;fi++)pi=nf[fi],rf=pi.toLowerCase(),of=pi[0].toUpperCase()+pi.slice(1),Vn(rf,"on"+of);var pi,rf,of,fi;Vn(Tp,"onAnimationEnd");Vn($p,"onAnimationIteration");Vn(Rp,"onAnimationStart");Vn("dblclick","onDoubleClick");Vn("focusin","onFocus");Vn("focusout","onBlur");Vn(_p,"onTransitionEnd");to("onMouseEnter",["mouseout","mouseover"]);to("onMouseLeave",["mouseout","mouseover"]);to("onPointerEnter",["pointerout","pointerover"]);to("onPointerLeave",["pointerout","pointerover"]);wr("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));wr("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));wr("onBeforeInput",["compositionend","keypress","textInput","paste"]);wr("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));wr("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));wr("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var Wo="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),yy=new Set("cancel close invalid load scroll toggle".split(" ").concat(Wo));function lf(e,t,n){var r=e.type||"unknown-event";e.currentTarget=n,yg(r,t,void 0,e),e.currentTarget=null}function Ip(e,t){t=(t&4)!==0;for(var n=0;n<e.length;n++){var r=e[n],o=r.event;r=r.listeners;e:{var l=void 0;if(t)for(var i=r.length-1;0<=i;i--){var s=r[i],a=s.instance,c=s.currentTarget;if(s=s.listener,a!==l&&o.isPropagationStopped())break e;lf(o,s,c),l=a}else for(i=0;i<r.length;i++){if(s=r[i],a=s.instance,c=s.currentTarget,s=s.listener,a!==l&&o.isPropagationStopped())break e;lf(o,s,c),l=a}}}if(Di)throw e=qa,Di=!1,qa=null,e}function oe(e,t){var n=t[au];n===void 0&&(n=t[au]=new Set);var r=e+"__bubble";n.has(r)||(Dp(t,e,2,!1),n.add(r))}function Aa(e,t,n){var r=0;t&&(r|=4),Dp(n,e,r,t)}var mi="_reactListening"+Math.random().toString(36).slice(2);function al(e){if(!e[mi]){e[mi]=!0,Ff.forEach(function(n){n!=="selectionchange"&&(yy.has(n)||Aa(n,!1,e),Aa(n,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[mi]||(t[mi]=!0,Aa("selectionchange",!1,t))}}function Dp(e,t,n,r){switch(gp(t)){case 1:var o=Dg;break;case 4:o=Pg;break;default:o=Mu}n=o.bind(null,t,n,e),o=void 0,!Za||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(o=!0),r?o!==void 0?e.addEventListener(t,n,{capture:!0,passive:o}):e.addEventListener(t,n,!0):o!==void 0?e.addEventListener(t,n,{passive:o}):e.addEventListener(t,n,!1)}function Ca(e,t,n,r,o){var l=r;if((t&1)===0&&(t&2)===0&&r!==null)e:for(;;){if(r===null)return;var i=r.tag;if(i===3||i===4){var s=r.stateNode.containerInfo;if(s===o||s.nodeType===8&&s.parentNode===o)break;if(i===4)for(i=r.return;i!==null;){var a=i.tag;if((a===3||a===4)&&(a=i.stateNode.containerInfo,a===o||a.nodeType===8&&a.parentNode===o))return;i=i.return}for(;s!==null;){if(i=cr(s),i===null)return;if(a=i.tag,a===5||a===6){r=l=i;continue e}s=s.parentNode}}r=r.return}np(function(){var c=l,h=Lu(n),p=[];e:{var g=Np.get(e);if(g!==void 0){var w=ju,v=e;switch(e){case"keypress":if(bi(n)===0)break e;case"keydown":case"keyup":w=Yg;break;case"focusin":v="focus",w=Sa;break;case"focusout":v="blur",w=Sa;break;case"beforeblur":case"afterblur":w=Sa;break;case"click":if(n.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":w=Qd;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":w=Og;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":w=qg;break;case Tp:case $p:case Rp:w=Fg;break;case _p:w=ey;break;case"scroll":w=Lg;break;case"wheel":w=ny;break;case"copy":case"cut":case"paste":w=Vg;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":w=Kd}var k=(t&4)!==0,R=!k&&e==="scroll",d=k?g!==null?g+"Capture":null:g;k=[];for(var u=c,f;u!==null;){f=u;var x=f.stateNode;if(f.tag===5&&x!==null&&(f=x,d!==null&&(x=nl(u,d),x!=null&&k.push(ul(u,x,f)))),R)break;u=u.return}0<k.length&&(g=new w(g,v,null,n,h),p.push({event:g,listeners:k}))}}if((t&7)===0){e:{if(g=e==="mouseover"||e==="pointerover",w=e==="mouseout"||e==="pointerout",g&&n!==Ya&&(v=n.relatedTarget||n.fromElement)&&(cr(v)||v[un]))break e;if((w||g)&&(g=h.window===h?h:(g=h.ownerDocument)?g.defaultView||g.parentWindow:window,w?(v=n.relatedTarget||n.toElement,w=c,v=v?cr(v):null,v!==null&&(R=kr(v),v!==R||v.tag!==5&&v.tag!==6)&&(v=null)):(w=null,v=c),w!==v)){if(k=Qd,x="onMouseLeave",d="onMouseEnter",u="mouse",(e==="pointerout"||e==="pointerover")&&(k=Kd,x="onPointerLeave",d="onPointerEnter",u="pointer"),R=w==null?g:Vr(w),f=v==null?g:Vr(v),g=new k(x,u+"leave",w,n,h),g.target=R,g.relatedTarget=f,x=null,cr(h)===c&&(k=new k(d,u+"enter",v,n,h),k.target=f,k.relatedTarget=R,x=k),R=x,w&&v)t:{for(k=w,d=v,u=0,f=k;f;f=zr(f))u++;for(f=0,x=d;x;x=zr(x))f++;for(;0<u-f;)k=zr(k),u--;for(;0<f-u;)d=zr(d),f--;for(;u--;){if(k===d||d!==null&&k===d.alternate)break t;k=zr(k),d=zr(d)}k=null}else k=null;w!==null&&sf(p,g,w,k,!1),v!==null&&R!==null&&sf(p,R,v,k,!0)}}e:{if(g=c?Vr(c):window,w=g.nodeName&&g.nodeName.toLowerCase(),w==="select"||w==="input"&&g.type==="file")var S=uy;else if(Zd(g))if(Sp)S=py;else{S=dy;var E=cy}else(w=g.nodeName)&&w.toLowerCase()==="input"&&(g.type==="checkbox"||g.type==="radio")&&(S=fy);if(S&&(S=S(e,c))){kp(p,S,n,h);break e}E&&E(e,g,c),e==="focusout"&&(E=g._wrapperState)&&E.controlled&&g.type==="number"&&Wa(g,"number",g.value)}switch(E=c?Vr(c):window,e){case"focusin":(Zd(E)||E.contentEditable==="true")&&(Fr=E,nu=c,Yo=null);break;case"focusout":Yo=nu=Fr=null;break;case"mousedown":ru=!0;break;case"contextmenu":case"mouseup":case"dragend":ru=!1,tf(p,n,h);break;case"selectionchange":if(gy)break;case"keydown":case"keyup":tf(p,n,h)}var b;if(Hu)e:{switch(e){case"compositionstart":var A="onCompositionStart";break e;case"compositionend":A="onCompositionEnd";break e;case"compositionupdate":A="onCompositionUpdate";break e}A=void 0}else Mr?xp(e,n)&&(A="onCompositionEnd"):e==="keydown"&&n.keyCode===229&&(A="onCompositionStart");A&&(vp&&n.locale!=="ko"&&(Mr||A!=="onCompositionStart"?A==="onCompositionEnd"&&Mr&&(b=yp()):(_n=h,Fu="value"in _n?_n.value:_n.textContent,Mr=!0)),E=Bi(c,A),0<E.length&&(A=new Gd(A,e,null,n,h),p.push({event:A,listeners:E}),b?A.data=b:(b=wp(n),b!==null&&(A.data=b)))),(b=oy?ly(e,n):iy(e,n))&&(c=Bi(c,"onBeforeInput"),0<c.length&&(h=new Gd("onBeforeInput","beforeinput",null,n,h),p.push({event:h,listeners:c}),h.data=b))}Ip(p,t)})}function ul(e,t,n){return{instance:e,listener:t,currentTarget:n}}function Bi(e,t){for(var n=t+"Capture",r=[];e!==null;){var o=e,l=o.stateNode;o.tag===5&&l!==null&&(o=l,l=nl(e,n),l!=null&&r.unshift(ul(e,l,o)),l=nl(e,t),l!=null&&r.push(ul(e,l,o))),e=e.return}return r}function zr(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e||null}function sf(e,t,n,r,o){for(var l=t._reactName,i=[];n!==null&&n!==r;){var s=n,a=s.alternate,c=s.stateNode;if(a!==null&&a===r)break;s.tag===5&&c!==null&&(s=c,o?(a=nl(n,l),a!=null&&i.unshift(ul(n,a,s))):o||(a=nl(n,l),a!=null&&i.push(ul(n,a,s)))),n=n.return}i.length!==0&&e.push({event:t,listeners:i})}var vy=/\r\n?/g,xy=/\u0000|\uFFFD/g;function af(e){return(typeof e=="string"?e:""+e).replace(vy,`
`).replace(xy,"")}function hi(e,t,n){if(t=af(t),af(e)!==t&&n)throw Error(C(425))}function Mi(){}var ou=null,lu=null;function iu(e,t){return e==="textarea"||e==="noscript"||typeof t.children=="string"||typeof t.children=="number"||typeof t.dangerouslySetInnerHTML=="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var su=typeof setTimeout=="function"?setTimeout:void 0,wy=typeof clearTimeout=="function"?clearTimeout:void 0,uf=typeof Promise=="function"?Promise:void 0,ky=typeof queueMicrotask=="function"?queueMicrotask:typeof uf<"u"?function(e){return uf.resolve(null).then(e).catch(Sy)}:su;function Sy(e){setTimeout(function(){throw e})}function Ta(e,t){var n=t,r=0;do{var o=n.nextSibling;if(e.removeChild(n),o&&o.nodeType===8)if(n=o.data,n==="/$"){if(r===0){e.removeChild(o),ll(t);return}r--}else n!=="$"&&n!=="$?"&&n!=="$!"||r++;n=o}while(n);ll(t)}function Ln(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?")break;if(t==="/$")return null}}return e}function cf(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="$"||n==="$!"||n==="$?"){if(t===0)return e;t--}else n==="/$"&&t++}e=e.previousSibling}return null}var uo=Math.random().toString(36).slice(2),Gt="__reactFiber$"+uo,cl="__reactProps$"+uo,un="__reactContainer$"+uo,au="__reactEvents$"+uo,by="__reactListeners$"+uo,Ey="__reactHandles$"+uo;function cr(e){var t=e[Gt];if(t)return t;for(var n=e.parentNode;n;){if(t=n[un]||n[Gt]){if(n=t.alternate,t.child!==null||n!==null&&n.child!==null)for(e=cf(e);e!==null;){if(n=e[Gt])return n;e=cf(e)}return t}e=n,n=e.parentNode}return null}function xl(e){return e=e[Gt]||e[un],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Vr(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(C(33))}function ls(e){return e[cl]||null}var uu=[],Hr=-1;function Hn(e){return{current:e}}function le(e){0>Hr||(e.current=uu[Hr],uu[Hr]=null,Hr--)}function re(e,t){Hr++,uu[Hr]=e.current,e.current=t}var jn={},Ke=Hn(jn),st=Hn(!1),hr=jn;function no(e,t){var n=e.type.contextTypes;if(!n)return jn;var r=e.stateNode;if(r&&r.__reactInternalMemoizedUnmaskedChildContext===t)return r.__reactInternalMemoizedMaskedChildContext;var o={},l;for(l in n)o[l]=t[l];return r&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=o),o}function at(e){return e=e.childContextTypes,e!=null}function Fi(){le(st),le(Ke)}function df(e,t,n){if(Ke.current!==jn)throw Error(C(168));re(Ke,t),re(st,n)}function Pp(e,t,n){var r=e.stateNode;if(t=t.childContextTypes,typeof r.getChildContext!="function")return n;r=r.getChildContext();for(var o in r)if(!(o in t))throw Error(C(108,cg(e)||"Unknown",o));return me({},n,r)}function ji(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||jn,hr=Ke.current,re(Ke,e),re(st,st.current),!0}function ff(e,t,n){var r=e.stateNode;if(!r)throw Error(C(169));n?(e=Pp(e,t,hr),r.__reactInternalMemoizedMergedChildContext=e,le(st),le(Ke),re(Ke,e)):le(st),re(st,n)}var rn=null,is=!1,$a=!1;function Lp(e){rn===null?rn=[e]:rn.push(e)}function Ay(e){is=!0,Lp(e)}function Wn(){if(!$a&&rn!==null){$a=!0;var e=0,t=ee;try{var n=rn;for(ee=1;e<n.length;e++){var r=n[e];do r=r(!0);while(r!==null)}rn=null,is=!1}catch(o){throw rn!==null&&(rn=rn.slice(e+1)),ip(zu,Wn),o}finally{ee=t,$a=!1}}return null}var Wr=[],Ur=0,Vi=null,Hi=0,St=[],bt=0,gr=null,on=1,ln="";function ar(e,t){Wr[Ur++]=Hi,Wr[Ur++]=Vi,Vi=e,Hi=t}function zp(e,t,n){St[bt++]=on,St[bt++]=ln,St[bt++]=gr,gr=e;var r=on;e=ln;var o=32-Ot(r)-1;r&=~(1<<o),n+=1;var l=32-Ot(t)+o;if(30<l){var i=o-o%5;l=(r&(1<<i)-1).toString(32),r>>=i,o-=i,on=1<<32-Ot(t)+o|n<<o|r,ln=l+e}else on=1<<l|n<<o|r,ln=e}function Uu(e){e.return!==null&&(ar(e,1),zp(e,1,0))}function Qu(e){for(;e===Vi;)Vi=Wr[--Ur],Wr[Ur]=null,Hi=Wr[--Ur],Wr[Ur]=null;for(;e===gr;)gr=St[--bt],St[bt]=null,ln=St[--bt],St[bt]=null,on=St[--bt],St[bt]=null}var ht=null,mt=null,ae=!1,zt=null;function Op(e,t){var n=Et(5,null,null,0);n.elementType="DELETED",n.stateNode=t,n.return=e,t=e.deletions,t===null?(e.deletions=[n],e.flags|=16):t.push(n)}function pf(e,t){switch(e.tag){case 5:var n=e.type;return t=t.nodeType!==1||n.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,ht=e,mt=Ln(t.firstChild),!0):!1;case 6:return t=e.pendingProps===""||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,ht=e,mt=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(n=gr!==null?{id:on,overflow:ln}:null,e.memoizedState={dehydrated:t,treeContext:n,retryLane:1073741824},n=Et(18,null,null,0),n.stateNode=t,n.return=e,e.child=n,ht=e,mt=null,!0):!1;default:return!1}}function cu(e){return(e.mode&1)!==0&&(e.flags&128)===0}function du(e){if(ae){var t=mt;if(t){var n=t;if(!pf(e,t)){if(cu(e))throw Error(C(418));t=Ln(n.nextSibling);var r=ht;t&&pf(e,t)?Op(r,n):(e.flags=e.flags&-4097|2,ae=!1,ht=e)}}else{if(cu(e))throw Error(C(418));e.flags=e.flags&-4097|2,ae=!1,ht=e}}}function mf(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;ht=e}function gi(e){if(e!==ht)return!1;if(!ae)return mf(e),ae=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!=="head"&&t!=="body"&&!iu(e.type,e.memoizedProps)),t&&(t=mt)){if(cu(e))throw Bp(),Error(C(418));for(;t;)Op(e,t),t=Ln(t.nextSibling)}if(mf(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(C(317));e:{for(e=e.nextSibling,t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="/$"){if(t===0){mt=Ln(e.nextSibling);break e}t--}else n!=="$"&&n!=="$!"&&n!=="$?"||t++}e=e.nextSibling}mt=null}}else mt=ht?Ln(e.stateNode.nextSibling):null;return!0}function Bp(){for(var e=mt;e;)e=Ln(e.nextSibling)}function ro(){mt=ht=null,ae=!1}function Gu(e){zt===null?zt=[e]:zt.push(e)}var Cy=fn.ReactCurrentBatchConfig;function Oo(e,t,n){if(e=n.ref,e!==null&&typeof e!="function"&&typeof e!="object"){if(n._owner){if(n=n._owner,n){if(n.tag!==1)throw Error(C(309));var r=n.stateNode}if(!r)throw Error(C(147,e));var o=r,l=""+e;return t!==null&&t.ref!==null&&typeof t.ref=="function"&&t.ref._stringRef===l?t.ref:(t=function(i){var s=o.refs;i===null?delete s[l]:s[l]=i},t._stringRef=l,t)}if(typeof e!="string")throw Error(C(284));if(!n._owner)throw Error(C(290,e))}return e}function yi(e,t){throw e=Object.prototype.toString.call(t),Error(C(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e))}function hf(e){var t=e._init;return t(e._payload)}function Mp(e){function t(d,u){if(e){var f=d.deletions;f===null?(d.deletions=[u],d.flags|=16):f.push(u)}}function n(d,u){if(!e)return null;for(;u!==null;)t(d,u),u=u.sibling;return null}function r(d,u){for(d=new Map;u!==null;)u.key!==null?d.set(u.key,u):d.set(u.index,u),u=u.sibling;return d}function o(d,u){return d=Mn(d,u),d.index=0,d.sibling=null,d}function l(d,u,f){return d.index=f,e?(f=d.alternate,f!==null?(f=f.index,f<u?(d.flags|=2,u):f):(d.flags|=2,u)):(d.flags|=1048576,u)}function i(d){return e&&d.alternate===null&&(d.flags|=2),d}function s(d,u,f,x){return u===null||u.tag!==6?(u=La(f,d.mode,x),u.return=d,u):(u=o(u,f),u.return=d,u)}function a(d,u,f,x){var S=f.type;return S===Br?h(d,u,f.props.children,x,f.key):u!==null&&(u.elementType===S||typeof S=="object"&&S!==null&&S.$$typeof===Cn&&hf(S)===u.type)?(x=o(u,f.props),x.ref=Oo(d,u,f),x.return=d,x):(x=_i(f.type,f.key,f.props,null,d.mode,x),x.ref=Oo(d,u,f),x.return=d,x)}function c(d,u,f,x){return u===null||u.tag!==4||u.stateNode.containerInfo!==f.containerInfo||u.stateNode.implementation!==f.implementation?(u=za(f,d.mode,x),u.return=d,u):(u=o(u,f.children||[]),u.return=d,u)}function h(d,u,f,x,S){return u===null||u.tag!==7?(u=mr(f,d.mode,x,S),u.return=d,u):(u=o(u,f),u.return=d,u)}function p(d,u,f){if(typeof u=="string"&&u!==""||typeof u=="number")return u=La(""+u,d.mode,f),u.return=d,u;if(typeof u=="object"&&u!==null){switch(u.$$typeof){case ni:return f=_i(u.type,u.key,u.props,null,d.mode,f),f.ref=Oo(d,null,u),f.return=d,f;case Or:return u=za(u,d.mode,f),u.return=d,u;case Cn:var x=u._init;return p(d,x(u._payload),f)}if(Vo(u)||Do(u))return u=mr(u,d.mode,f,null),u.return=d,u;yi(d,u)}return null}function g(d,u,f,x){var S=u!==null?u.key:null;if(typeof f=="string"&&f!==""||typeof f=="number")return S!==null?null:s(d,u,""+f,x);if(typeof f=="object"&&f!==null){switch(f.$$typeof){case ni:return f.key===S?a(d,u,f,x):null;case Or:return f.key===S?c(d,u,f,x):null;case Cn:return S=f._init,g(d,u,S(f._payload),x)}if(Vo(f)||Do(f))return S!==null?null:h(d,u,f,x,null);yi(d,f)}return null}function w(d,u,f,x,S){if(typeof x=="string"&&x!==""||typeof x=="number")return d=d.get(f)||null,s(u,d,""+x,S);if(typeof x=="object"&&x!==null){switch(x.$$typeof){case ni:return d=d.get(x.key===null?f:x.key)||null,a(u,d,x,S);case Or:return d=d.get(x.key===null?f:x.key)||null,c(u,d,x,S);case Cn:var E=x._init;return w(d,u,f,E(x._payload),S)}if(Vo(x)||Do(x))return d=d.get(f)||null,h(u,d,x,S,null);yi(u,x)}return null}function v(d,u,f,x){for(var S=null,E=null,b=u,A=u=0,B=null;b!==null&&A<f.length;A++){b.index>A?(B=b,b=null):B=b.sibling;var I=g(d,b,f[A],x);if(I===null){b===null&&(b=B);break}e&&b&&I.alternate===null&&t(d,b),u=l(I,u,A),E===null?S=I:E.sibling=I,E=I,b=B}if(A===f.length)return n(d,b),ae&&ar(d,A),S;if(b===null){for(;A<f.length;A++)b=p(d,f[A],x),b!==null&&(u=l(b,u,A),E===null?S=b:E.sibling=b,E=b);return ae&&ar(d,A),S}for(b=r(d,b);A<f.length;A++)B=w(b,d,A,f[A],x),B!==null&&(e&&B.alternate!==null&&b.delete(B.key===null?A:B.key),u=l(B,u,A),E===null?S=B:E.sibling=B,E=B);return e&&b.forEach(function(U){return t(d,U)}),ae&&ar(d,A),S}function k(d,u,f,x){var S=Do(f);if(typeof S!="function")throw Error(C(150));if(f=S.call(f),f==null)throw Error(C(151));for(var E=S=null,b=u,A=u=0,B=null,I=f.next();b!==null&&!I.done;A++,I=f.next()){b.index>A?(B=b,b=null):B=b.sibling;var U=g(d,b,I.value,x);if(U===null){b===null&&(b=B);break}e&&b&&U.alternate===null&&t(d,b),u=l(U,u,A),E===null?S=U:E.sibling=U,E=U,b=B}if(I.done)return n(d,b),ae&&ar(d,A),S;if(b===null){for(;!I.done;A++,I=f.next())I=p(d,I.value,x),I!==null&&(u=l(I,u,A),E===null?S=I:E.sibling=I,E=I);return ae&&ar(d,A),S}for(b=r(d,b);!I.done;A++,I=f.next())I=w(b,d,A,I.value,x),I!==null&&(e&&I.alternate!==null&&b.delete(I.key===null?A:I.key),u=l(I,u,A),E===null?S=I:E.sibling=I,E=I);return e&&b.forEach(function(Z){return t(d,Z)}),ae&&ar(d,A),S}function R(d,u,f,x){if(typeof f=="object"&&f!==null&&f.type===Br&&f.key===null&&(f=f.props.children),typeof f=="object"&&f!==null){switch(f.$$typeof){case ni:e:{for(var S=f.key,E=u;E!==null;){if(E.key===S){if(S=f.type,S===Br){if(E.tag===7){n(d,E.sibling),u=o(E,f.props.children),u.return=d,d=u;break e}}else if(E.elementType===S||typeof S=="object"&&S!==null&&S.$$typeof===Cn&&hf(S)===E.type){n(d,E.sibling),u=o(E,f.props),u.ref=Oo(d,E,f),u.return=d,d=u;break e}n(d,E);break}else t(d,E);E=E.sibling}f.type===Br?(u=mr(f.props.children,d.mode,x,f.key),u.return=d,d=u):(x=_i(f.type,f.key,f.props,null,d.mode,x),x.ref=Oo(d,u,f),x.return=d,d=x)}return i(d);case Or:e:{for(E=f.key;u!==null;){if(u.key===E)if(u.tag===4&&u.stateNode.containerInfo===f.containerInfo&&u.stateNode.implementation===f.implementation){n(d,u.sibling),u=o(u,f.children||[]),u.return=d,d=u;break e}else{n(d,u);break}else t(d,u);u=u.sibling}u=za(f,d.mode,x),u.return=d,d=u}return i(d);case Cn:return E=f._init,R(d,u,E(f._payload),x)}if(Vo(f))return v(d,u,f,x);if(Do(f))return k(d,u,f,x);yi(d,f)}return typeof f=="string"&&f!==""||typeof f=="number"?(f=""+f,u!==null&&u.tag===6?(n(d,u.sibling),u=o(u,f),u.return=d,d=u):(n(d,u),u=La(f,d.mode,x),u.return=d,d=u),i(d)):n(d,u)}return R}var oo=Mp(!0),Fp=Mp(!1),Wi=Hn(null),Ui=null,Qr=null,Ku=null;function Yu(){Ku=Qr=Ui=null}function Xu(e){var t=Wi.current;le(Wi),e._currentValue=t}function fu(e,t,n){for(;e!==null;){var r=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,r!==null&&(r.childLanes|=t)):r!==null&&(r.childLanes&t)!==t&&(r.childLanes|=t),e===n)break;e=e.return}}function Jr(e,t){Ui=e,Ku=Qr=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&(it=!0),e.firstContext=null)}function Ct(e){var t=e._currentValue;if(Ku!==e)if(e={context:e,memoizedValue:t,next:null},Qr===null){if(Ui===null)throw Error(C(308));Qr=e,Ui.dependencies={lanes:0,firstContext:e}}else Qr=Qr.next=e;return t}var dr=null;function Zu(e){dr===null?dr=[e]:dr.push(e)}function jp(e,t,n,r){var o=t.interleaved;return o===null?(n.next=n,Zu(t)):(n.next=o.next,o.next=n),t.interleaved=n,cn(e,r)}function cn(e,t){e.lanes|=t;var n=e.alternate;for(n!==null&&(n.lanes|=t),n=e,e=e.return;e!==null;)e.childLanes|=t,n=e.alternate,n!==null&&(n.childLanes|=t),n=e,e=e.return;return n.tag===3?n.stateNode:null}var Tn=!1;function qu(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Vp(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function sn(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function zn(e,t,n){var r=e.updateQueue;if(r===null)return null;if(r=r.shared,(Q&2)!==0){var o=r.pending;return o===null?t.next=t:(t.next=o.next,o.next=t),r.pending=t,cn(e,n)}return o=r.interleaved,o===null?(t.next=t,Zu(r)):(t.next=o.next,o.next=t),r.interleaved=t,cn(e,n)}function Ei(e,t,n){if(t=t.updateQueue,t!==null&&(t=t.shared,(n&4194240)!==0)){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,Ou(e,n)}}function gf(e,t){var n=e.updateQueue,r=e.alternate;if(r!==null&&(r=r.updateQueue,n===r)){var o=null,l=null;if(n=n.firstBaseUpdate,n!==null){do{var i={eventTime:n.eventTime,lane:n.lane,tag:n.tag,payload:n.payload,callback:n.callback,next:null};l===null?o=l=i:l=l.next=i,n=n.next}while(n!==null);l===null?o=l=t:l=l.next=t}else o=l=t;n={baseState:r.baseState,firstBaseUpdate:o,lastBaseUpdate:l,shared:r.shared,effects:r.effects},e.updateQueue=n;return}e=n.lastBaseUpdate,e===null?n.firstBaseUpdate=t:e.next=t,n.lastBaseUpdate=t}function Qi(e,t,n,r){var o=e.updateQueue;Tn=!1;var l=o.firstBaseUpdate,i=o.lastBaseUpdate,s=o.shared.pending;if(s!==null){o.shared.pending=null;var a=s,c=a.next;a.next=null,i===null?l=c:i.next=c,i=a;var h=e.alternate;h!==null&&(h=h.updateQueue,s=h.lastBaseUpdate,s!==i&&(s===null?h.firstBaseUpdate=c:s.next=c,h.lastBaseUpdate=a))}if(l!==null){var p=o.baseState;i=0,h=c=a=null,s=l;do{var g=s.lane,w=s.eventTime;if((r&g)===g){h!==null&&(h=h.next={eventTime:w,lane:0,tag:s.tag,payload:s.payload,callback:s.callback,next:null});e:{var v=e,k=s;switch(g=t,w=n,k.tag){case 1:if(v=k.payload,typeof v=="function"){p=v.call(w,p,g);break e}p=v;break e;case 3:v.flags=v.flags&-65537|128;case 0:if(v=k.payload,g=typeof v=="function"?v.call(w,p,g):v,g==null)break e;p=me({},p,g);break e;case 2:Tn=!0}}s.callback!==null&&s.lane!==0&&(e.flags|=64,g=o.effects,g===null?o.effects=[s]:g.push(s))}else w={eventTime:w,lane:g,tag:s.tag,payload:s.payload,callback:s.callback,next:null},h===null?(c=h=w,a=p):h=h.next=w,i|=g;if(s=s.next,s===null){if(s=o.shared.pending,s===null)break;g=s,s=g.next,g.next=null,o.lastBaseUpdate=g,o.shared.pending=null}}while(!0);if(h===null&&(a=p),o.baseState=a,o.firstBaseUpdate=c,o.lastBaseUpdate=h,t=o.shared.interleaved,t!==null){o=t;do i|=o.lane,o=o.next;while(o!==t)}else l===null&&(o.shared.lanes=0);vr|=i,e.lanes=i,e.memoizedState=p}}function yf(e,t,n){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var r=e[t],o=r.callback;if(o!==null){if(r.callback=null,r=n,typeof o!="function")throw Error(C(191,o));o.call(r)}}}var wl={},Yt=Hn(wl),dl=Hn(wl),fl=Hn(wl);function fr(e){if(e===wl)throw Error(C(174));return e}function Ju(e,t){switch(re(fl,t),re(dl,e),re(Yt,wl),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:Qa(null,"");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=Qa(t,e)}le(Yt),re(Yt,t)}function lo(){le(Yt),le(dl),le(fl)}function Hp(e){fr(fl.current);var t=fr(Yt.current),n=Qa(t,e.type);t!==n&&(re(dl,e),re(Yt,n))}function ec(e){dl.current===e&&(le(Yt),le(dl))}var fe=Hn(0);function Gi(e){for(var t=e;t!==null;){if(t.tag===13){var n=t.memoizedState;if(n!==null&&(n=n.dehydrated,n===null||n.data==="$?"||n.data==="$!"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var Ra=[];function tc(){for(var e=0;e<Ra.length;e++)Ra[e]._workInProgressVersionPrimary=null;Ra.length=0}var Ai=fn.ReactCurrentDispatcher,_a=fn.ReactCurrentBatchConfig,yr=0,pe=null,Ce=null,Pe=null,Ki=!1,Xo=!1,pl=0,Ty=0;function Ue(){throw Error(C(321))}function nc(e,t){if(t===null)return!1;for(var n=0;n<t.length&&n<e.length;n++)if(!Mt(e[n],t[n]))return!1;return!0}function rc(e,t,n,r,o,l){if(yr=l,pe=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Ai.current=e===null||e.memoizedState===null?Ny:Iy,e=n(r,o),Xo){l=0;do{if(Xo=!1,pl=0,25<=l)throw Error(C(301));l+=1,Pe=Ce=null,t.updateQueue=null,Ai.current=Dy,e=n(r,o)}while(Xo)}if(Ai.current=Yi,t=Ce!==null&&Ce.next!==null,yr=0,Pe=Ce=pe=null,Ki=!1,t)throw Error(C(300));return e}function oc(){var e=pl!==0;return pl=0,e}function Qt(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return Pe===null?pe.memoizedState=Pe=e:Pe=Pe.next=e,Pe}function Tt(){if(Ce===null){var e=pe.alternate;e=e!==null?e.memoizedState:null}else e=Ce.next;var t=Pe===null?pe.memoizedState:Pe.next;if(t!==null)Pe=t,Ce=e;else{if(e===null)throw Error(C(310));Ce=e,e={memoizedState:Ce.memoizedState,baseState:Ce.baseState,baseQueue:Ce.baseQueue,queue:Ce.queue,next:null},Pe===null?pe.memoizedState=Pe=e:Pe=Pe.next=e}return Pe}function ml(e,t){return typeof t=="function"?t(e):t}function Na(e){var t=Tt(),n=t.queue;if(n===null)throw Error(C(311));n.lastRenderedReducer=e;var r=Ce,o=r.baseQueue,l=n.pending;if(l!==null){if(o!==null){var i=o.next;o.next=l.next,l.next=i}r.baseQueue=o=l,n.pending=null}if(o!==null){l=o.next,r=r.baseState;var s=i=null,a=null,c=l;do{var h=c.lane;if((yr&h)===h)a!==null&&(a=a.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),r=c.hasEagerState?c.eagerState:e(r,c.action);else{var p={lane:h,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};a===null?(s=a=p,i=r):a=a.next=p,pe.lanes|=h,vr|=h}c=c.next}while(c!==null&&c!==l);a===null?i=r:a.next=s,Mt(r,t.memoizedState)||(it=!0),t.memoizedState=r,t.baseState=i,t.baseQueue=a,n.lastRenderedState=r}if(e=n.interleaved,e!==null){o=e;do l=o.lane,pe.lanes|=l,vr|=l,o=o.next;while(o!==e)}else o===null&&(n.lanes=0);return[t.memoizedState,n.dispatch]}function Ia(e){var t=Tt(),n=t.queue;if(n===null)throw Error(C(311));n.lastRenderedReducer=e;var r=n.dispatch,o=n.pending,l=t.memoizedState;if(o!==null){n.pending=null;var i=o=o.next;do l=e(l,i.action),i=i.next;while(i!==o);Mt(l,t.memoizedState)||(it=!0),t.memoizedState=l,t.baseQueue===null&&(t.baseState=l),n.lastRenderedState=l}return[l,r]}function Wp(){}function Up(e,t){var n=pe,r=Tt(),o=t(),l=!Mt(r.memoizedState,o);if(l&&(r.memoizedState=o,it=!0),r=r.queue,lc(Kp.bind(null,n,r,e),[e]),r.getSnapshot!==t||l||Pe!==null&&Pe.memoizedState.tag&1){if(n.flags|=2048,hl(9,Gp.bind(null,n,r,o,t),void 0,null),Le===null)throw Error(C(349));(yr&30)!==0||Qp(n,t,o)}return o}function Qp(e,t,n){e.flags|=16384,e={getSnapshot:t,value:n},t=pe.updateQueue,t===null?(t={lastEffect:null,stores:null},pe.updateQueue=t,t.stores=[e]):(n=t.stores,n===null?t.stores=[e]:n.push(e))}function Gp(e,t,n,r){t.value=n,t.getSnapshot=r,Yp(t)&&Xp(e)}function Kp(e,t,n){return n(function(){Yp(t)&&Xp(e)})}function Yp(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!Mt(e,n)}catch{return!0}}function Xp(e){var t=cn(e,1);t!==null&&Bt(t,e,1,-1)}function vf(e){var t=Qt();return typeof e=="function"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:ml,lastRenderedState:e},t.queue=e,e=e.dispatch=_y.bind(null,pe,e),[t.memoizedState,e]}function hl(e,t,n,r){return e={tag:e,create:t,destroy:n,deps:r,next:null},t=pe.updateQueue,t===null?(t={lastEffect:null,stores:null},pe.updateQueue=t,t.lastEffect=e.next=e):(n=t.lastEffect,n===null?t.lastEffect=e.next=e:(r=n.next,n.next=e,e.next=r,t.lastEffect=e)),e}function Zp(){return Tt().memoizedState}function Ci(e,t,n,r){var o=Qt();pe.flags|=e,o.memoizedState=hl(1|t,n,void 0,r===void 0?null:r)}function ss(e,t,n,r){var o=Tt();r=r===void 0?null:r;var l=void 0;if(Ce!==null){var i=Ce.memoizedState;if(l=i.destroy,r!==null&&nc(r,i.deps)){o.memoizedState=hl(t,n,l,r);return}}pe.flags|=e,o.memoizedState=hl(1|t,n,l,r)}function xf(e,t){return Ci(8390656,8,e,t)}function lc(e,t){return ss(2048,8,e,t)}function qp(e,t){return ss(4,2,e,t)}function Jp(e,t){return ss(4,4,e,t)}function em(e,t){if(typeof t=="function")return e=e(),t(e),function(){t(null)};if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function tm(e,t,n){return n=n!=null?n.concat([e]):null,ss(4,4,em.bind(null,t,e),n)}function ic(){}function nm(e,t){var n=Tt();t=t===void 0?null:t;var r=n.memoizedState;return r!==null&&t!==null&&nc(t,r[1])?r[0]:(n.memoizedState=[e,t],e)}function rm(e,t){var n=Tt();t=t===void 0?null:t;var r=n.memoizedState;return r!==null&&t!==null&&nc(t,r[1])?r[0]:(e=e(),n.memoizedState=[e,t],e)}function om(e,t,n){return(yr&21)===0?(e.baseState&&(e.baseState=!1,it=!0),e.memoizedState=n):(Mt(n,t)||(n=up(),pe.lanes|=n,vr|=n,e.baseState=!0),t)}function $y(e,t){var n=ee;ee=n!==0&&4>n?n:4,e(!0);var r=_a.transition;_a.transition={};try{e(!1),t()}finally{ee=n,_a.transition=r}}function lm(){return Tt().memoizedState}function Ry(e,t,n){var r=Bn(e);if(n={lane:r,action:n,hasEagerState:!1,eagerState:null,next:null},im(e))sm(t,n);else if(n=jp(e,t,n,r),n!==null){var o=Je();Bt(n,e,r,o),am(n,t,r)}}function _y(e,t,n){var r=Bn(e),o={lane:r,action:n,hasEagerState:!1,eagerState:null,next:null};if(im(e))sm(t,o);else{var l=e.alternate;if(e.lanes===0&&(l===null||l.lanes===0)&&(l=t.lastRenderedReducer,l!==null))try{var i=t.lastRenderedState,s=l(i,n);if(o.hasEagerState=!0,o.eagerState=s,Mt(s,i)){var a=t.interleaved;a===null?(o.next=o,Zu(t)):(o.next=a.next,a.next=o),t.interleaved=o;return}}catch{}n=jp(e,t,o,r),n!==null&&(o=Je(),Bt(n,e,r,o),am(n,t,r))}}function im(e){var t=e.alternate;return e===pe||t!==null&&t===pe}function sm(e,t){Xo=Ki=!0;var n=e.pending;n===null?t.next=t:(t.next=n.next,n.next=t),e.pending=t}function am(e,t,n){if((n&4194240)!==0){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,Ou(e,n)}}var Yi={readContext:Ct,useCallback:Ue,useContext:Ue,useEffect:Ue,useImperativeHandle:Ue,useInsertionEffect:Ue,useLayoutEffect:Ue,useMemo:Ue,useReducer:Ue,useRef:Ue,useState:Ue,useDebugValue:Ue,useDeferredValue:Ue,useTransition:Ue,useMutableSource:Ue,useSyncExternalStore:Ue,useId:Ue,unstable_isNewReconciler:!1},Ny={readContext:Ct,useCallback:function(e,t){return Qt().memoizedState=[e,t===void 0?null:t],e},useContext:Ct,useEffect:xf,useImperativeHandle:function(e,t,n){return n=n!=null?n.concat([e]):null,Ci(4194308,4,em.bind(null,t,e),n)},useLayoutEffect:function(e,t){return Ci(4194308,4,e,t)},useInsertionEffect:function(e,t){return Ci(4,2,e,t)},useMemo:function(e,t){var n=Qt();return t=t===void 0?null:t,e=e(),n.memoizedState=[e,t],e},useReducer:function(e,t,n){var r=Qt();return t=n!==void 0?n(t):t,r.memoizedState=r.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},r.queue=e,e=e.dispatch=Ry.bind(null,pe,e),[r.memoizedState,e]},useRef:function(e){var t=Qt();return e={current:e},t.memoizedState=e},useState:vf,useDebugValue:ic,useDeferredValue:function(e){return Qt().memoizedState=e},useTransition:function(){var e=vf(!1),t=e[0];return e=$y.bind(null,e[1]),Qt().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,n){var r=pe,o=Qt();if(ae){if(n===void 0)throw Error(C(407));n=n()}else{if(n=t(),Le===null)throw Error(C(349));(yr&30)!==0||Qp(r,t,n)}o.memoizedState=n;var l={value:n,getSnapshot:t};return o.queue=l,xf(Kp.bind(null,r,l,e),[e]),r.flags|=2048,hl(9,Gp.bind(null,r,l,n,t),void 0,null),n},useId:function(){var e=Qt(),t=Le.identifierPrefix;if(ae){var n=ln,r=on;n=(r&~(1<<32-Ot(r)-1)).toString(32)+n,t=":"+t+"R"+n,n=pl++,0<n&&(t+="H"+n.toString(32)),t+=":"}else n=Ty++,t=":"+t+"r"+n.toString(32)+":";return e.memoizedState=t},unstable_isNewReconciler:!1},Iy={readContext:Ct,useCallback:nm,useContext:Ct,useEffect:lc,useImperativeHandle:tm,useInsertionEffect:qp,useLayoutEffect:Jp,useMemo:rm,useReducer:Na,useRef:Zp,useState:function(){return Na(ml)},useDebugValue:ic,useDeferredValue:function(e){var t=Tt();return om(t,Ce.memoizedState,e)},useTransition:function(){var e=Na(ml)[0],t=Tt().memoizedState;return[e,t]},useMutableSource:Wp,useSyncExternalStore:Up,useId:lm,unstable_isNewReconciler:!1},Dy={readContext:Ct,useCallback:nm,useContext:Ct,useEffect:lc,useImperativeHandle:tm,useInsertionEffect:qp,useLayoutEffect:Jp,useMemo:rm,useReducer:Ia,useRef:Zp,useState:function(){return Ia(ml)},useDebugValue:ic,useDeferredValue:function(e){var t=Tt();return Ce===null?t.memoizedState=e:om(t,Ce.memoizedState,e)},useTransition:function(){var e=Ia(ml)[0],t=Tt().memoizedState;return[e,t]},useMutableSource:Wp,useSyncExternalStore:Up,useId:lm,unstable_isNewReconciler:!1};function Pt(e,t){if(e&&e.defaultProps){t=me({},t),e=e.defaultProps;for(var n in e)t[n]===void 0&&(t[n]=e[n]);return t}return t}function pu(e,t,n,r){t=e.memoizedState,n=n(r,t),n=n==null?t:me({},t,n),e.memoizedState=n,e.lanes===0&&(e.updateQueue.baseState=n)}var as={isMounted:function(e){return(e=e._reactInternals)?kr(e)===e:!1},enqueueSetState:function(e,t,n){e=e._reactInternals;var r=Je(),o=Bn(e),l=sn(r,o);l.payload=t,n!=null&&(l.callback=n),t=zn(e,l,o),t!==null&&(Bt(t,e,o,r),Ei(t,e,o))},enqueueReplaceState:function(e,t,n){e=e._reactInternals;var r=Je(),o=Bn(e),l=sn(r,o);l.tag=1,l.payload=t,n!=null&&(l.callback=n),t=zn(e,l,o),t!==null&&(Bt(t,e,o,r),Ei(t,e,o))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var n=Je(),r=Bn(e),o=sn(n,r);o.tag=2,t!=null&&(o.callback=t),t=zn(e,o,r),t!==null&&(Bt(t,e,r,n),Ei(t,e,r))}};function wf(e,t,n,r,o,l,i){return e=e.stateNode,typeof e.shouldComponentUpdate=="function"?e.shouldComponentUpdate(r,l,i):t.prototype&&t.prototype.isPureReactComponent?!sl(n,r)||!sl(o,l):!0}function um(e,t,n){var r=!1,o=jn,l=t.contextType;return typeof l=="object"&&l!==null?l=Ct(l):(o=at(t)?hr:Ke.current,r=t.contextTypes,l=(r=r!=null)?no(e,o):jn),t=new t(n,l),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=as,e.stateNode=t,t._reactInternals=e,r&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=o,e.__reactInternalMemoizedMaskedChildContext=l),t}function kf(e,t,n,r){e=t.state,typeof t.componentWillReceiveProps=="function"&&t.componentWillReceiveProps(n,r),typeof t.UNSAFE_componentWillReceiveProps=="function"&&t.UNSAFE_componentWillReceiveProps(n,r),t.state!==e&&as.enqueueReplaceState(t,t.state,null)}function mu(e,t,n,r){var o=e.stateNode;o.props=n,o.state=e.memoizedState,o.refs={},qu(e);var l=t.contextType;typeof l=="object"&&l!==null?o.context=Ct(l):(l=at(t)?hr:Ke.current,o.context=no(e,l)),o.state=e.memoizedState,l=t.getDerivedStateFromProps,typeof l=="function"&&(pu(e,t,l,n),o.state=e.memoizedState),typeof t.getDerivedStateFromProps=="function"||typeof o.getSnapshotBeforeUpdate=="function"||typeof o.UNSAFE_componentWillMount!="function"&&typeof o.componentWillMount!="function"||(t=o.state,typeof o.componentWillMount=="function"&&o.componentWillMount(),typeof o.UNSAFE_componentWillMount=="function"&&o.UNSAFE_componentWillMount(),t!==o.state&&as.enqueueReplaceState(o,o.state,null),Qi(e,n,o,r),o.state=e.memoizedState),typeof o.componentDidMount=="function"&&(e.flags|=4194308)}function io(e,t){try{var n="",r=t;do n+=ug(r),r=r.return;while(r);var o=n}catch(l){o=`
Error generating stack: `+l.message+`
`+l.stack}return{value:e,source:t,stack:o,digest:null}}function Da(e,t,n){return{value:e,source:null,stack:n??null,digest:t??null}}function hu(e,t){try{console.error(t.value)}catch(n){setTimeout(function(){throw n})}}var Py=typeof WeakMap=="function"?WeakMap:Map;function cm(e,t,n){n=sn(-1,n),n.tag=3,n.payload={element:null};var r=t.value;return n.callback=function(){Zi||(Zi=!0,Au=r),hu(e,t)},n}function dm(e,t,n){n=sn(-1,n),n.tag=3;var r=e.type.getDerivedStateFromError;if(typeof r=="function"){var o=t.value;n.payload=function(){return r(o)},n.callback=function(){hu(e,t)}}var l=e.stateNode;return l!==null&&typeof l.componentDidCatch=="function"&&(n.callback=function(){hu(e,t),typeof r!="function"&&(On===null?On=new Set([this]):On.add(this));var i=t.stack;this.componentDidCatch(t.value,{componentStack:i!==null?i:""})}),n}function Sf(e,t,n){var r=e.pingCache;if(r===null){r=e.pingCache=new Py;var o=new Set;r.set(t,o)}else o=r.get(t),o===void 0&&(o=new Set,r.set(t,o));o.has(n)||(o.add(n),e=Ky.bind(null,e,t,n),t.then(e,e))}function bf(e){do{var t;if((t=e.tag===13)&&(t=e.memoizedState,t=t!==null?t.dehydrated!==null:!0),t)return e;e=e.return}while(e!==null);return null}function Ef(e,t,n,r,o){return(e.mode&1)===0?(e===t?e.flags|=65536:(e.flags|=128,n.flags|=131072,n.flags&=-52805,n.tag===1&&(n.alternate===null?n.tag=17:(t=sn(-1,1),t.tag=2,zn(n,t,1))),n.lanes|=1),e):(e.flags|=65536,e.lanes=o,e)}var Ly=fn.ReactCurrentOwner,it=!1;function qe(e,t,n,r){t.child=e===null?Fp(t,null,n,r):oo(t,e.child,n,r)}function Af(e,t,n,r,o){n=n.render;var l=t.ref;return Jr(t,o),r=rc(e,t,n,r,l,o),n=oc(),e!==null&&!it?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~o,dn(e,t,o)):(ae&&n&&Uu(t),t.flags|=1,qe(e,t,r,o),t.child)}function Cf(e,t,n,r,o){if(e===null){var l=n.type;return typeof l=="function"&&!mc(l)&&l.defaultProps===void 0&&n.compare===null&&n.defaultProps===void 0?(t.tag=15,t.type=l,fm(e,t,l,r,o)):(e=_i(n.type,null,r,t,t.mode,o),e.ref=t.ref,e.return=t,t.child=e)}if(l=e.child,(e.lanes&o)===0){var i=l.memoizedProps;if(n=n.compare,n=n!==null?n:sl,n(i,r)&&e.ref===t.ref)return dn(e,t,o)}return t.flags|=1,e=Mn(l,r),e.ref=t.ref,e.return=t,t.child=e}function fm(e,t,n,r,o){if(e!==null){var l=e.memoizedProps;if(sl(l,r)&&e.ref===t.ref)if(it=!1,t.pendingProps=r=l,(e.lanes&o)!==0)(e.flags&131072)!==0&&(it=!0);else return t.lanes=e.lanes,dn(e,t,o)}return gu(e,t,n,r,o)}function pm(e,t,n){var r=t.pendingProps,o=r.children,l=e!==null?e.memoizedState:null;if(r.mode==="hidden")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},re(Kr,pt),pt|=n;else{if((n&1073741824)===0)return e=l!==null?l.baseLanes|n:n,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,re(Kr,pt),pt|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},r=l!==null?l.baseLanes:n,re(Kr,pt),pt|=r}else l!==null?(r=l.baseLanes|n,t.memoizedState=null):r=n,re(Kr,pt),pt|=r;return qe(e,t,o,n),t.child}function mm(e,t){var n=t.ref;(e===null&&n!==null||e!==null&&e.ref!==n)&&(t.flags|=512,t.flags|=2097152)}function gu(e,t,n,r,o){var l=at(n)?hr:Ke.current;return l=no(t,l),Jr(t,o),n=rc(e,t,n,r,l,o),r=oc(),e!==null&&!it?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~o,dn(e,t,o)):(ae&&r&&Uu(t),t.flags|=1,qe(e,t,n,o),t.child)}function Tf(e,t,n,r,o){if(at(n)){var l=!0;ji(t)}else l=!1;if(Jr(t,o),t.stateNode===null)Ti(e,t),um(t,n,r),mu(t,n,r,o),r=!0;else if(e===null){var i=t.stateNode,s=t.memoizedProps;i.props=s;var a=i.context,c=n.contextType;typeof c=="object"&&c!==null?c=Ct(c):(c=at(n)?hr:Ke.current,c=no(t,c));var h=n.getDerivedStateFromProps,p=typeof h=="function"||typeof i.getSnapshotBeforeUpdate=="function";p||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(s!==r||a!==c)&&kf(t,i,r,c),Tn=!1;var g=t.memoizedState;i.state=g,Qi(t,r,i,o),a=t.memoizedState,s!==r||g!==a||st.current||Tn?(typeof h=="function"&&(pu(t,n,h,r),a=t.memoizedState),(s=Tn||wf(t,n,s,r,g,a,c))?(p||typeof i.UNSAFE_componentWillMount!="function"&&typeof i.componentWillMount!="function"||(typeof i.componentWillMount=="function"&&i.componentWillMount(),typeof i.UNSAFE_componentWillMount=="function"&&i.UNSAFE_componentWillMount()),typeof i.componentDidMount=="function"&&(t.flags|=4194308)):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),t.memoizedProps=r,t.memoizedState=a),i.props=r,i.state=a,i.context=c,r=s):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),r=!1)}else{i=t.stateNode,Vp(e,t),s=t.memoizedProps,c=t.type===t.elementType?s:Pt(t.type,s),i.props=c,p=t.pendingProps,g=i.context,a=n.contextType,typeof a=="object"&&a!==null?a=Ct(a):(a=at(n)?hr:Ke.current,a=no(t,a));var w=n.getDerivedStateFromProps;(h=typeof w=="function"||typeof i.getSnapshotBeforeUpdate=="function")||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(s!==p||g!==a)&&kf(t,i,r,a),Tn=!1,g=t.memoizedState,i.state=g,Qi(t,r,i,o);var v=t.memoizedState;s!==p||g!==v||st.current||Tn?(typeof w=="function"&&(pu(t,n,w,r),v=t.memoizedState),(c=Tn||wf(t,n,c,r,g,v,a)||!1)?(h||typeof i.UNSAFE_componentWillUpdate!="function"&&typeof i.componentWillUpdate!="function"||(typeof i.componentWillUpdate=="function"&&i.componentWillUpdate(r,v,a),typeof i.UNSAFE_componentWillUpdate=="function"&&i.UNSAFE_componentWillUpdate(r,v,a)),typeof i.componentDidUpdate=="function"&&(t.flags|=4),typeof i.getSnapshotBeforeUpdate=="function"&&(t.flags|=1024)):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&g===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&g===e.memoizedState||(t.flags|=1024),t.memoizedProps=r,t.memoizedState=v),i.props=r,i.state=v,i.context=a,r=c):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&g===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&g===e.memoizedState||(t.flags|=1024),r=!1)}return yu(e,t,n,r,l,o)}function yu(e,t,n,r,o,l){mm(e,t);var i=(t.flags&128)!==0;if(!r&&!i)return o&&ff(t,n,!1),dn(e,t,l);r=t.stateNode,Ly.current=t;var s=i&&typeof n.getDerivedStateFromError!="function"?null:r.render();return t.flags|=1,e!==null&&i?(t.child=oo(t,e.child,null,l),t.child=oo(t,null,s,l)):qe(e,t,s,l),t.memoizedState=r.state,o&&ff(t,n,!0),t.child}function hm(e){var t=e.stateNode;t.pendingContext?df(e,t.pendingContext,t.pendingContext!==t.context):t.context&&df(e,t.context,!1),Ju(e,t.containerInfo)}function $f(e,t,n,r,o){return ro(),Gu(o),t.flags|=256,qe(e,t,n,r),t.child}var vu={dehydrated:null,treeContext:null,retryLane:0};function xu(e){return{baseLanes:e,cachePool:null,transitions:null}}function gm(e,t,n){var r=t.pendingProps,o=fe.current,l=!1,i=(t.flags&128)!==0,s;if((s=i)||(s=e!==null&&e.memoizedState===null?!1:(o&2)!==0),s?(l=!0,t.flags&=-129):(e===null||e.memoizedState!==null)&&(o|=1),re(fe,o&1),e===null)return du(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null)?((t.mode&1)===0?t.lanes=1:e.data==="$!"?t.lanes=8:t.lanes=1073741824,null):(i=r.children,e=r.fallback,l?(r=t.mode,l=t.child,i={mode:"hidden",children:i},(r&1)===0&&l!==null?(l.childLanes=0,l.pendingProps=i):l=ds(i,r,0,null),e=mr(e,r,n,null),l.return=t,e.return=t,l.sibling=e,t.child=l,t.child.memoizedState=xu(n),t.memoizedState=vu,e):sc(t,i));if(o=e.memoizedState,o!==null&&(s=o.dehydrated,s!==null))return zy(e,t,i,r,s,o,n);if(l){l=r.fallback,i=t.mode,o=e.child,s=o.sibling;var a={mode:"hidden",children:r.children};return(i&1)===0&&t.child!==o?(r=t.child,r.childLanes=0,r.pendingProps=a,t.deletions=null):(r=Mn(o,a),r.subtreeFlags=o.subtreeFlags&14680064),s!==null?l=Mn(s,l):(l=mr(l,i,n,null),l.flags|=2),l.return=t,r.return=t,r.sibling=l,t.child=r,r=l,l=t.child,i=e.child.memoizedState,i=i===null?xu(n):{baseLanes:i.baseLanes|n,cachePool:null,transitions:i.transitions},l.memoizedState=i,l.childLanes=e.childLanes&~n,t.memoizedState=vu,r}return l=e.child,e=l.sibling,r=Mn(l,{mode:"visible",children:r.children}),(t.mode&1)===0&&(r.lanes=n),r.return=t,r.sibling=null,e!==null&&(n=t.deletions,n===null?(t.deletions=[e],t.flags|=16):n.push(e)),t.child=r,t.memoizedState=null,r}function sc(e,t){return t=ds({mode:"visible",children:t},e.mode,0,null),t.return=e,e.child=t}function vi(e,t,n,r){return r!==null&&Gu(r),oo(t,e.child,null,n),e=sc(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function zy(e,t,n,r,o,l,i){if(n)return t.flags&256?(t.flags&=-257,r=Da(Error(C(422))),vi(e,t,i,r)):t.memoizedState!==null?(t.child=e.child,t.flags|=128,null):(l=r.fallback,o=t.mode,r=ds({mode:"visible",children:r.children},o,0,null),l=mr(l,o,i,null),l.flags|=2,r.return=t,l.return=t,r.sibling=l,t.child=r,(t.mode&1)!==0&&oo(t,e.child,null,i),t.child.memoizedState=xu(i),t.memoizedState=vu,l);if((t.mode&1)===0)return vi(e,t,i,null);if(o.data==="$!"){if(r=o.nextSibling&&o.nextSibling.dataset,r)var s=r.dgst;return r=s,l=Error(C(419)),r=Da(l,r,void 0),vi(e,t,i,r)}if(s=(i&e.childLanes)!==0,it||s){if(r=Le,r!==null){switch(i&-i){case 4:o=2;break;case 16:o=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:o=32;break;case 536870912:o=268435456;break;default:o=0}o=(o&(r.suspendedLanes|i))!==0?0:o,o!==0&&o!==l.retryLane&&(l.retryLane=o,cn(e,o),Bt(r,e,o,-1))}return pc(),r=Da(Error(C(421))),vi(e,t,i,r)}return o.data==="$?"?(t.flags|=128,t.child=e.child,t=Yy.bind(null,e),o._reactRetry=t,null):(e=l.treeContext,mt=Ln(o.nextSibling),ht=t,ae=!0,zt=null,e!==null&&(St[bt++]=on,St[bt++]=ln,St[bt++]=gr,on=e.id,ln=e.overflow,gr=t),t=sc(t,r.children),t.flags|=4096,t)}function Rf(e,t,n){e.lanes|=t;var r=e.alternate;r!==null&&(r.lanes|=t),fu(e.return,t,n)}function Pa(e,t,n,r,o){var l=e.memoizedState;l===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:r,tail:n,tailMode:o}:(l.isBackwards=t,l.rendering=null,l.renderingStartTime=0,l.last=r,l.tail=n,l.tailMode=o)}function ym(e,t,n){var r=t.pendingProps,o=r.revealOrder,l=r.tail;if(qe(e,t,r.children,n),r=fe.current,(r&2)!==0)r=r&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Rf(e,n,t);else if(e.tag===19)Rf(e,n,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}r&=1}if(re(fe,r),(t.mode&1)===0)t.memoizedState=null;else switch(o){case"forwards":for(n=t.child,o=null;n!==null;)e=n.alternate,e!==null&&Gi(e)===null&&(o=n),n=n.sibling;n=o,n===null?(o=t.child,t.child=null):(o=n.sibling,n.sibling=null),Pa(t,!1,o,n,l);break;case"backwards":for(n=null,o=t.child,t.child=null;o!==null;){if(e=o.alternate,e!==null&&Gi(e)===null){t.child=o;break}e=o.sibling,o.sibling=n,n=o,o=e}Pa(t,!0,n,null,l);break;case"together":Pa(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function Ti(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function dn(e,t,n){if(e!==null&&(t.dependencies=e.dependencies),vr|=t.lanes,(n&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(C(153));if(t.child!==null){for(e=t.child,n=Mn(e,e.pendingProps),t.child=n,n.return=t;e.sibling!==null;)e=e.sibling,n=n.sibling=Mn(e,e.pendingProps),n.return=t;n.sibling=null}return t.child}function Oy(e,t,n){switch(t.tag){case 3:hm(t),ro();break;case 5:Hp(t);break;case 1:at(t.type)&&ji(t);break;case 4:Ju(t,t.stateNode.containerInfo);break;case 10:var r=t.type._context,o=t.memoizedProps.value;re(Wi,r._currentValue),r._currentValue=o;break;case 13:if(r=t.memoizedState,r!==null)return r.dehydrated!==null?(re(fe,fe.current&1),t.flags|=128,null):(n&t.child.childLanes)!==0?gm(e,t,n):(re(fe,fe.current&1),e=dn(e,t,n),e!==null?e.sibling:null);re(fe,fe.current&1);break;case 19:if(r=(n&t.childLanes)!==0,(e.flags&128)!==0){if(r)return ym(e,t,n);t.flags|=128}if(o=t.memoizedState,o!==null&&(o.rendering=null,o.tail=null,o.lastEffect=null),re(fe,fe.current),r)break;return null;case 22:case 23:return t.lanes=0,pm(e,t,n)}return dn(e,t,n)}var vm,wu,xm,wm;vm=function(e,t){for(var n=t.child;n!==null;){if(n.tag===5||n.tag===6)e.appendChild(n.stateNode);else if(n.tag!==4&&n.child!==null){n.child.return=n,n=n.child;continue}if(n===t)break;for(;n.sibling===null;){if(n.return===null||n.return===t)return;n=n.return}n.sibling.return=n.return,n=n.sibling}};wu=function(){};xm=function(e,t,n,r){var o=e.memoizedProps;if(o!==r){e=t.stateNode,fr(Yt.current);var l=null;switch(n){case"input":o=Va(e,o),r=Va(e,r),l=[];break;case"select":o=me({},o,{value:void 0}),r=me({},r,{value:void 0}),l=[];break;case"textarea":o=Ua(e,o),r=Ua(e,r),l=[];break;default:typeof o.onClick!="function"&&typeof r.onClick=="function"&&(e.onclick=Mi)}Ga(n,r);var i;n=null;for(c in o)if(!r.hasOwnProperty(c)&&o.hasOwnProperty(c)&&o[c]!=null)if(c==="style"){var s=o[c];for(i in s)s.hasOwnProperty(i)&&(n||(n={}),n[i]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(el.hasOwnProperty(c)?l||(l=[]):(l=l||[]).push(c,null));for(c in r){var a=r[c];if(s=o?.[c],r.hasOwnProperty(c)&&a!==s&&(a!=null||s!=null))if(c==="style")if(s){for(i in s)!s.hasOwnProperty(i)||a&&a.hasOwnProperty(i)||(n||(n={}),n[i]="");for(i in a)a.hasOwnProperty(i)&&s[i]!==a[i]&&(n||(n={}),n[i]=a[i])}else n||(l||(l=[]),l.push(c,n)),n=a;else c==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,s=s?s.__html:void 0,a!=null&&s!==a&&(l=l||[]).push(c,a)):c==="children"?typeof a!="string"&&typeof a!="number"||(l=l||[]).push(c,""+a):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(el.hasOwnProperty(c)?(a!=null&&c==="onScroll"&&oe("scroll",e),l||s===a||(l=[])):(l=l||[]).push(c,a))}n&&(l=l||[]).push("style",n);var c=l;(t.updateQueue=c)&&(t.flags|=4)}};wm=function(e,t,n,r){n!==r&&(t.flags|=4)};function Bo(e,t){if(!ae)switch(e.tailMode){case"hidden":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?e.tail=null:n.sibling=null;break;case"collapsed":n=e.tail;for(var r=null;n!==null;)n.alternate!==null&&(r=n),n=n.sibling;r===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:r.sibling=null}}function Qe(e){var t=e.alternate!==null&&e.alternate.child===e.child,n=0,r=0;if(t)for(var o=e.child;o!==null;)n|=o.lanes|o.childLanes,r|=o.subtreeFlags&14680064,r|=o.flags&14680064,o.return=e,o=o.sibling;else for(o=e.child;o!==null;)n|=o.lanes|o.childLanes,r|=o.subtreeFlags,r|=o.flags,o.return=e,o=o.sibling;return e.subtreeFlags|=r,e.childLanes=n,t}function By(e,t,n){var r=t.pendingProps;switch(Qu(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return Qe(t),null;case 1:return at(t.type)&&Fi(),Qe(t),null;case 3:return r=t.stateNode,lo(),le(st),le(Ke),tc(),r.pendingContext&&(r.context=r.pendingContext,r.pendingContext=null),(e===null||e.child===null)&&(gi(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,zt!==null&&($u(zt),zt=null))),wu(e,t),Qe(t),null;case 5:ec(t);var o=fr(fl.current);if(n=t.type,e!==null&&t.stateNode!=null)xm(e,t,n,r,o),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!r){if(t.stateNode===null)throw Error(C(166));return Qe(t),null}if(e=fr(Yt.current),gi(t)){r=t.stateNode,n=t.type;var l=t.memoizedProps;switch(r[Gt]=t,r[cl]=l,e=(t.mode&1)!==0,n){case"dialog":oe("cancel",r),oe("close",r);break;case"iframe":case"object":case"embed":oe("load",r);break;case"video":case"audio":for(o=0;o<Wo.length;o++)oe(Wo[o],r);break;case"source":oe("error",r);break;case"img":case"image":case"link":oe("error",r),oe("load",r);break;case"details":oe("toggle",r);break;case"input":zd(r,l),oe("invalid",r);break;case"select":r._wrapperState={wasMultiple:!!l.multiple},oe("invalid",r);break;case"textarea":Bd(r,l),oe("invalid",r)}Ga(n,l),o=null;for(var i in l)if(l.hasOwnProperty(i)){var s=l[i];i==="children"?typeof s=="string"?r.textContent!==s&&(l.suppressHydrationWarning!==!0&&hi(r.textContent,s,e),o=["children",s]):typeof s=="number"&&r.textContent!==""+s&&(l.suppressHydrationWarning!==!0&&hi(r.textContent,s,e),o=["children",""+s]):el.hasOwnProperty(i)&&s!=null&&i==="onScroll"&&oe("scroll",r)}switch(n){case"input":ri(r),Od(r,l,!0);break;case"textarea":ri(r),Md(r);break;case"select":case"option":break;default:typeof l.onClick=="function"&&(r.onclick=Mi)}r=o,t.updateQueue=r,r!==null&&(t.flags|=4)}else{i=o.nodeType===9?o:o.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=Kf(n)),e==="http://www.w3.org/1999/xhtml"?n==="script"?(e=i.createElement("div"),e.innerHTML="<script><\/script>",e=e.removeChild(e.firstChild)):typeof r.is=="string"?e=i.createElement(n,{is:r.is}):(e=i.createElement(n),n==="select"&&(i=e,r.multiple?i.multiple=!0:r.size&&(i.size=r.size))):e=i.createElementNS(e,n),e[Gt]=t,e[cl]=r,vm(e,t,!1,!1),t.stateNode=e;e:{switch(i=Ka(n,r),n){case"dialog":oe("cancel",e),oe("close",e),o=r;break;case"iframe":case"object":case"embed":oe("load",e),o=r;break;case"video":case"audio":for(o=0;o<Wo.length;o++)oe(Wo[o],e);o=r;break;case"source":oe("error",e),o=r;break;case"img":case"image":case"link":oe("error",e),oe("load",e),o=r;break;case"details":oe("toggle",e),o=r;break;case"input":zd(e,r),o=Va(e,r),oe("invalid",e);break;case"option":o=r;break;case"select":e._wrapperState={wasMultiple:!!r.multiple},o=me({},r,{value:void 0}),oe("invalid",e);break;case"textarea":Bd(e,r),o=Ua(e,r),oe("invalid",e);break;default:o=r}Ga(n,o),s=o;for(l in s)if(s.hasOwnProperty(l)){var a=s[l];l==="style"?Zf(e,a):l==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,a!=null&&Yf(e,a)):l==="children"?typeof a=="string"?(n!=="textarea"||a!=="")&&tl(e,a):typeof a=="number"&&tl(e,""+a):l!=="suppressContentEditableWarning"&&l!=="suppressHydrationWarning"&&l!=="autoFocus"&&(el.hasOwnProperty(l)?a!=null&&l==="onScroll"&&oe("scroll",e):a!=null&&Nu(e,l,a,i))}switch(n){case"input":ri(e),Od(e,r,!1);break;case"textarea":ri(e),Md(e);break;case"option":r.value!=null&&e.setAttribute("value",""+Fn(r.value));break;case"select":e.multiple=!!r.multiple,l=r.value,l!=null?Yr(e,!!r.multiple,l,!1):r.defaultValue!=null&&Yr(e,!!r.multiple,r.defaultValue,!0);break;default:typeof o.onClick=="function"&&(e.onclick=Mi)}switch(n){case"button":case"input":case"select":case"textarea":r=!!r.autoFocus;break e;case"img":r=!0;break e;default:r=!1}}r&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return Qe(t),null;case 6:if(e&&t.stateNode!=null)wm(e,t,e.memoizedProps,r);else{if(typeof r!="string"&&t.stateNode===null)throw Error(C(166));if(n=fr(fl.current),fr(Yt.current),gi(t)){if(r=t.stateNode,n=t.memoizedProps,r[Gt]=t,(l=r.nodeValue!==n)&&(e=ht,e!==null))switch(e.tag){case 3:hi(r.nodeValue,n,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&hi(r.nodeValue,n,(e.mode&1)!==0)}l&&(t.flags|=4)}else r=(n.nodeType===9?n:n.ownerDocument).createTextNode(r),r[Gt]=t,t.stateNode=r}return Qe(t),null;case 13:if(le(fe),r=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(ae&&mt!==null&&(t.mode&1)!==0&&(t.flags&128)===0)Bp(),ro(),t.flags|=98560,l=!1;else if(l=gi(t),r!==null&&r.dehydrated!==null){if(e===null){if(!l)throw Error(C(318));if(l=t.memoizedState,l=l!==null?l.dehydrated:null,!l)throw Error(C(317));l[Gt]=t}else ro(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;Qe(t),l=!1}else zt!==null&&($u(zt),zt=null),l=!0;if(!l)return t.flags&65536?t:null}return(t.flags&128)!==0?(t.lanes=n,t):(r=r!==null,r!==(e!==null&&e.memoizedState!==null)&&r&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(fe.current&1)!==0?Te===0&&(Te=3):pc())),t.updateQueue!==null&&(t.flags|=4),Qe(t),null);case 4:return lo(),wu(e,t),e===null&&al(t.stateNode.containerInfo),Qe(t),null;case 10:return Xu(t.type._context),Qe(t),null;case 17:return at(t.type)&&Fi(),Qe(t),null;case 19:if(le(fe),l=t.memoizedState,l===null)return Qe(t),null;if(r=(t.flags&128)!==0,i=l.rendering,i===null)if(r)Bo(l,!1);else{if(Te!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(i=Gi(e),i!==null){for(t.flags|=128,Bo(l,!1),r=i.updateQueue,r!==null&&(t.updateQueue=r,t.flags|=4),t.subtreeFlags=0,r=n,n=t.child;n!==null;)l=n,e=r,l.flags&=14680066,i=l.alternate,i===null?(l.childLanes=0,l.lanes=e,l.child=null,l.subtreeFlags=0,l.memoizedProps=null,l.memoizedState=null,l.updateQueue=null,l.dependencies=null,l.stateNode=null):(l.childLanes=i.childLanes,l.lanes=i.lanes,l.child=i.child,l.subtreeFlags=0,l.deletions=null,l.memoizedProps=i.memoizedProps,l.memoizedState=i.memoizedState,l.updateQueue=i.updateQueue,l.type=i.type,e=i.dependencies,l.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),n=n.sibling;return re(fe,fe.current&1|2),t.child}e=e.sibling}l.tail!==null&&we()>so&&(t.flags|=128,r=!0,Bo(l,!1),t.lanes=4194304)}else{if(!r)if(e=Gi(i),e!==null){if(t.flags|=128,r=!0,n=e.updateQueue,n!==null&&(t.updateQueue=n,t.flags|=4),Bo(l,!0),l.tail===null&&l.tailMode==="hidden"&&!i.alternate&&!ae)return Qe(t),null}else 2*we()-l.renderingStartTime>so&&n!==1073741824&&(t.flags|=128,r=!0,Bo(l,!1),t.lanes=4194304);l.isBackwards?(i.sibling=t.child,t.child=i):(n=l.last,n!==null?n.sibling=i:t.child=i,l.last=i)}return l.tail!==null?(t=l.tail,l.rendering=t,l.tail=t.sibling,l.renderingStartTime=we(),t.sibling=null,n=fe.current,re(fe,r?n&1|2:n&1),t):(Qe(t),null);case 22:case 23:return fc(),r=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==r&&(t.flags|=8192),r&&(t.mode&1)!==0?(pt&1073741824)!==0&&(Qe(t),t.subtreeFlags&6&&(t.flags|=8192)):Qe(t),null;case 24:return null;case 25:return null}throw Error(C(156,t.tag))}function My(e,t){switch(Qu(t),t.tag){case 1:return at(t.type)&&Fi(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return lo(),le(st),le(Ke),tc(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return ec(t),null;case 13:if(le(fe),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(C(340));ro()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return le(fe),null;case 4:return lo(),null;case 10:return Xu(t.type._context),null;case 22:case 23:return fc(),null;case 24:return null;default:return null}}var xi=!1,Ge=!1,Fy=typeof WeakSet=="function"?WeakSet:Set,_=null;function Gr(e,t){var n=e.ref;if(n!==null)if(typeof n=="function")try{n(null)}catch(r){ve(e,t,r)}else n.current=null}function ku(e,t,n){try{n()}catch(r){ve(e,t,r)}}var _f=!1;function jy(e,t){if(ou=zi,e=Ap(),Wu(e)){if("selectionStart"in e)var n={start:e.selectionStart,end:e.selectionEnd};else e:{n=(n=e.ownerDocument)&&n.defaultView||window;var r=n.getSelection&&n.getSelection();if(r&&r.rangeCount!==0){n=r.anchorNode;var o=r.anchorOffset,l=r.focusNode;r=r.focusOffset;try{n.nodeType,l.nodeType}catch{n=null;break e}var i=0,s=-1,a=-1,c=0,h=0,p=e,g=null;t:for(;;){for(var w;p!==n||o!==0&&p.nodeType!==3||(s=i+o),p!==l||r!==0&&p.nodeType!==3||(a=i+r),p.nodeType===3&&(i+=p.nodeValue.length),(w=p.firstChild)!==null;)g=p,p=w;for(;;){if(p===e)break t;if(g===n&&++c===o&&(s=i),g===l&&++h===r&&(a=i),(w=p.nextSibling)!==null)break;p=g,g=p.parentNode}p=w}n=s===-1||a===-1?null:{start:s,end:a}}else n=null}n=n||{start:0,end:0}}else n=null;for(lu={focusedElem:e,selectionRange:n},zi=!1,_=t;_!==null;)if(t=_,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,_=e;else for(;_!==null;){t=_;try{var v=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(v!==null){var k=v.memoizedProps,R=v.memoizedState,d=t.stateNode,u=d.getSnapshotBeforeUpdate(t.elementType===t.type?k:Pt(t.type,k),R);d.__reactInternalSnapshotBeforeUpdate=u}break;case 3:var f=t.stateNode.containerInfo;f.nodeType===1?f.textContent="":f.nodeType===9&&f.documentElement&&f.removeChild(f.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(C(163))}}catch(x){ve(t,t.return,x)}if(e=t.sibling,e!==null){e.return=t.return,_=e;break}_=t.return}return v=_f,_f=!1,v}function Zo(e,t,n){var r=t.updateQueue;if(r=r!==null?r.lastEffect:null,r!==null){var o=r=r.next;do{if((o.tag&e)===e){var l=o.destroy;o.destroy=void 0,l!==void 0&&ku(t,n,l)}o=o.next}while(o!==r)}}function us(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var n=t=t.next;do{if((n.tag&e)===e){var r=n.create;n.destroy=r()}n=n.next}while(n!==t)}}function Su(e){var t=e.ref;if(t!==null){var n=e.stateNode;e.tag,e=n,typeof t=="function"?t(e):t.current=e}}function km(e){var t=e.alternate;t!==null&&(e.alternate=null,km(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[Gt],delete t[cl],delete t[au],delete t[by],delete t[Ey])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Sm(e){return e.tag===5||e.tag===3||e.tag===4}function Nf(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Sm(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2||e.child===null||e.tag===4)continue e;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function bu(e,t,n){var r=e.tag;if(r===5||r===6)e=e.stateNode,t?n.nodeType===8?n.parentNode.insertBefore(e,t):n.insertBefore(e,t):(n.nodeType===8?(t=n.parentNode,t.insertBefore(e,n)):(t=n,t.appendChild(e)),n=n._reactRootContainer,n!=null||t.onclick!==null||(t.onclick=Mi));else if(r!==4&&(e=e.child,e!==null))for(bu(e,t,n),e=e.sibling;e!==null;)bu(e,t,n),e=e.sibling}function Eu(e,t,n){var r=e.tag;if(r===5||r===6)e=e.stateNode,t?n.insertBefore(e,t):n.appendChild(e);else if(r!==4&&(e=e.child,e!==null))for(Eu(e,t,n),e=e.sibling;e!==null;)Eu(e,t,n),e=e.sibling}var Me=null,Lt=!1;function An(e,t,n){for(n=n.child;n!==null;)bm(e,t,n),n=n.sibling}function bm(e,t,n){if(Kt&&typeof Kt.onCommitFiberUnmount=="function")try{Kt.onCommitFiberUnmount(ts,n)}catch{}switch(n.tag){case 5:Ge||Gr(n,t);case 6:var r=Me,o=Lt;Me=null,An(e,t,n),Me=r,Lt=o,Me!==null&&(Lt?(e=Me,n=n.stateNode,e.nodeType===8?e.parentNode.removeChild(n):e.removeChild(n)):Me.removeChild(n.stateNode));break;case 18:Me!==null&&(Lt?(e=Me,n=n.stateNode,e.nodeType===8?Ta(e.parentNode,n):e.nodeType===1&&Ta(e,n),ll(e)):Ta(Me,n.stateNode));break;case 4:r=Me,o=Lt,Me=n.stateNode.containerInfo,Lt=!0,An(e,t,n),Me=r,Lt=o;break;case 0:case 11:case 14:case 15:if(!Ge&&(r=n.updateQueue,r!==null&&(r=r.lastEffect,r!==null))){o=r=r.next;do{var l=o,i=l.destroy;l=l.tag,i!==void 0&&((l&2)!==0||(l&4)!==0)&&ku(n,t,i),o=o.next}while(o!==r)}An(e,t,n);break;case 1:if(!Ge&&(Gr(n,t),r=n.stateNode,typeof r.componentWillUnmount=="function"))try{r.props=n.memoizedProps,r.state=n.memoizedState,r.componentWillUnmount()}catch(s){ve(n,t,s)}An(e,t,n);break;case 21:An(e,t,n);break;case 22:n.mode&1?(Ge=(r=Ge)||n.memoizedState!==null,An(e,t,n),Ge=r):An(e,t,n);break;default:An(e,t,n)}}function If(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var n=e.stateNode;n===null&&(n=e.stateNode=new Fy),t.forEach(function(r){var o=Xy.bind(null,e,r);n.has(r)||(n.add(r),r.then(o,o))})}}function Dt(e,t){var n=t.deletions;if(n!==null)for(var r=0;r<n.length;r++){var o=n[r];try{var l=e,i=t,s=i;e:for(;s!==null;){switch(s.tag){case 5:Me=s.stateNode,Lt=!1;break e;case 3:Me=s.stateNode.containerInfo,Lt=!0;break e;case 4:Me=s.stateNode.containerInfo,Lt=!0;break e}s=s.return}if(Me===null)throw Error(C(160));bm(l,i,o),Me=null,Lt=!1;var a=o.alternate;a!==null&&(a.return=null),o.return=null}catch(c){ve(o,t,c)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)Em(t,e),t=t.sibling}function Em(e,t){var n=e.alternate,r=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:if(Dt(t,e),Ut(e),r&4){try{Zo(3,e,e.return),us(3,e)}catch(k){ve(e,e.return,k)}try{Zo(5,e,e.return)}catch(k){ve(e,e.return,k)}}break;case 1:Dt(t,e),Ut(e),r&512&&n!==null&&Gr(n,n.return);break;case 5:if(Dt(t,e),Ut(e),r&512&&n!==null&&Gr(n,n.return),e.flags&32){var o=e.stateNode;try{tl(o,"")}catch(k){ve(e,e.return,k)}}if(r&4&&(o=e.stateNode,o!=null)){var l=e.memoizedProps,i=n!==null?n.memoizedProps:l,s=e.type,a=e.updateQueue;if(e.updateQueue=null,a!==null)try{s==="input"&&l.type==="radio"&&l.name!=null&&Qf(o,l),Ka(s,i);var c=Ka(s,l);for(i=0;i<a.length;i+=2){var h=a[i],p=a[i+1];h==="style"?Zf(o,p):h==="dangerouslySetInnerHTML"?Yf(o,p):h==="children"?tl(o,p):Nu(o,h,p,c)}switch(s){case"input":Ha(o,l);break;case"textarea":Gf(o,l);break;case"select":var g=o._wrapperState.wasMultiple;o._wrapperState.wasMultiple=!!l.multiple;var w=l.value;w!=null?Yr(o,!!l.multiple,w,!1):g!==!!l.multiple&&(l.defaultValue!=null?Yr(o,!!l.multiple,l.defaultValue,!0):Yr(o,!!l.multiple,l.multiple?[]:"",!1))}o[cl]=l}catch(k){ve(e,e.return,k)}}break;case 6:if(Dt(t,e),Ut(e),r&4){if(e.stateNode===null)throw Error(C(162));o=e.stateNode,l=e.memoizedProps;try{o.nodeValue=l}catch(k){ve(e,e.return,k)}}break;case 3:if(Dt(t,e),Ut(e),r&4&&n!==null&&n.memoizedState.isDehydrated)try{ll(t.containerInfo)}catch(k){ve(e,e.return,k)}break;case 4:Dt(t,e),Ut(e);break;case 13:Dt(t,e),Ut(e),o=e.child,o.flags&8192&&(l=o.memoizedState!==null,o.stateNode.isHidden=l,!l||o.alternate!==null&&o.alternate.memoizedState!==null||(cc=we())),r&4&&If(e);break;case 22:if(h=n!==null&&n.memoizedState!==null,e.mode&1?(Ge=(c=Ge)||h,Dt(t,e),Ge=c):Dt(t,e),Ut(e),r&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!h&&(e.mode&1)!==0)for(_=e,h=e.child;h!==null;){for(p=_=h;_!==null;){switch(g=_,w=g.child,g.tag){case 0:case 11:case 14:case 15:Zo(4,g,g.return);break;case 1:Gr(g,g.return);var v=g.stateNode;if(typeof v.componentWillUnmount=="function"){r=g,n=g.return;try{t=r,v.props=t.memoizedProps,v.state=t.memoizedState,v.componentWillUnmount()}catch(k){ve(r,n,k)}}break;case 5:Gr(g,g.return);break;case 22:if(g.memoizedState!==null){Pf(p);continue}}w!==null?(w.return=g,_=w):Pf(p)}h=h.sibling}e:for(h=null,p=e;;){if(p.tag===5){if(h===null){h=p;try{o=p.stateNode,c?(l=o.style,typeof l.setProperty=="function"?l.setProperty("display","none","important"):l.display="none"):(s=p.stateNode,a=p.memoizedProps.style,i=a!=null&&a.hasOwnProperty("display")?a.display:null,s.style.display=Xf("display",i))}catch(k){ve(e,e.return,k)}}}else if(p.tag===6){if(h===null)try{p.stateNode.nodeValue=c?"":p.memoizedProps}catch(k){ve(e,e.return,k)}}else if((p.tag!==22&&p.tag!==23||p.memoizedState===null||p===e)&&p.child!==null){p.child.return=p,p=p.child;continue}if(p===e)break e;for(;p.sibling===null;){if(p.return===null||p.return===e)break e;h===p&&(h=null),p=p.return}h===p&&(h=null),p.sibling.return=p.return,p=p.sibling}}break;case 19:Dt(t,e),Ut(e),r&4&&If(e);break;case 21:break;default:Dt(t,e),Ut(e)}}function Ut(e){var t=e.flags;if(t&2){try{e:{for(var n=e.return;n!==null;){if(Sm(n)){var r=n;break e}n=n.return}throw Error(C(160))}switch(r.tag){case 5:var o=r.stateNode;r.flags&32&&(tl(o,""),r.flags&=-33);var l=Nf(e);Eu(e,l,o);break;case 3:case 4:var i=r.stateNode.containerInfo,s=Nf(e);bu(e,s,i);break;default:throw Error(C(161))}}catch(a){ve(e,e.return,a)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function Vy(e,t,n){_=e,Am(e,t,n)}function Am(e,t,n){for(var r=(e.mode&1)!==0;_!==null;){var o=_,l=o.child;if(o.tag===22&&r){var i=o.memoizedState!==null||xi;if(!i){var s=o.alternate,a=s!==null&&s.memoizedState!==null||Ge;s=xi;var c=Ge;if(xi=i,(Ge=a)&&!c)for(_=o;_!==null;)i=_,a=i.child,i.tag===22&&i.memoizedState!==null?Lf(o):a!==null?(a.return=i,_=a):Lf(o);for(;l!==null;)_=l,Am(l,t,n),l=l.sibling;_=o,xi=s,Ge=c}Df(e,t,n)}else(o.subtreeFlags&8772)!==0&&l!==null?(l.return=o,_=l):Df(e,t,n)}}function Df(e){for(;_!==null;){var t=_;if((t.flags&8772)!==0){var n=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:Ge||us(5,t);break;case 1:var r=t.stateNode;if(t.flags&4&&!Ge)if(n===null)r.componentDidMount();else{var o=t.elementType===t.type?n.memoizedProps:Pt(t.type,n.memoizedProps);r.componentDidUpdate(o,n.memoizedState,r.__reactInternalSnapshotBeforeUpdate)}var l=t.updateQueue;l!==null&&yf(t,l,r);break;case 3:var i=t.updateQueue;if(i!==null){if(n=null,t.child!==null)switch(t.child.tag){case 5:n=t.child.stateNode;break;case 1:n=t.child.stateNode}yf(t,i,n)}break;case 5:var s=t.stateNode;if(n===null&&t.flags&4){n=s;var a=t.memoizedProps;switch(t.type){case"button":case"input":case"select":case"textarea":a.autoFocus&&n.focus();break;case"img":a.src&&(n.src=a.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var c=t.alternate;if(c!==null){var h=c.memoizedState;if(h!==null){var p=h.dehydrated;p!==null&&ll(p)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(C(163))}Ge||t.flags&512&&Su(t)}catch(g){ve(t,t.return,g)}}if(t===e){_=null;break}if(n=t.sibling,n!==null){n.return=t.return,_=n;break}_=t.return}}function Pf(e){for(;_!==null;){var t=_;if(t===e){_=null;break}var n=t.sibling;if(n!==null){n.return=t.return,_=n;break}_=t.return}}function Lf(e){for(;_!==null;){var t=_;try{switch(t.tag){case 0:case 11:case 15:var n=t.return;try{us(4,t)}catch(a){ve(t,n,a)}break;case 1:var r=t.stateNode;if(typeof r.componentDidMount=="function"){var o=t.return;try{r.componentDidMount()}catch(a){ve(t,o,a)}}var l=t.return;try{Su(t)}catch(a){ve(t,l,a)}break;case 5:var i=t.return;try{Su(t)}catch(a){ve(t,i,a)}}}catch(a){ve(t,t.return,a)}if(t===e){_=null;break}var s=t.sibling;if(s!==null){s.return=t.return,_=s;break}_=t.return}}var Hy=Math.ceil,Xi=fn.ReactCurrentDispatcher,ac=fn.ReactCurrentOwner,At=fn.ReactCurrentBatchConfig,Q=0,Le=null,Se=null,Fe=0,pt=0,Kr=Hn(0),Te=0,gl=null,vr=0,cs=0,uc=0,qo=null,lt=null,cc=0,so=1/0,nn=null,Zi=!1,Au=null,On=null,wi=!1,Nn=null,qi=0,Jo=0,Cu=null,$i=-1,Ri=0;function Je(){return(Q&6)!==0?we():$i!==-1?$i:$i=we()}function Bn(e){return(e.mode&1)===0?1:(Q&2)!==0&&Fe!==0?Fe&-Fe:Cy.transition!==null?(Ri===0&&(Ri=up()),Ri):(e=ee,e!==0||(e=window.event,e=e===void 0?16:gp(e.type)),e)}function Bt(e,t,n,r){if(50<Jo)throw Jo=0,Cu=null,Error(C(185));yl(e,n,r),((Q&2)===0||e!==Le)&&(e===Le&&((Q&2)===0&&(cs|=n),Te===4&&Rn(e,Fe)),ut(e,r),n===1&&Q===0&&(t.mode&1)===0&&(so=we()+500,is&&Wn()))}function ut(e,t){var n=e.callbackNode;$g(e,t);var r=Li(e,e===Le?Fe:0);if(r===0)n!==null&&Vd(n),e.callbackNode=null,e.callbackPriority=0;else if(t=r&-r,e.callbackPriority!==t){if(n!=null&&Vd(n),t===1)e.tag===0?Ay(zf.bind(null,e)):Lp(zf.bind(null,e)),ky(function(){(Q&6)===0&&Wn()}),n=null;else{switch(cp(r)){case 1:n=zu;break;case 4:n=sp;break;case 16:n=Pi;break;case 536870912:n=ap;break;default:n=Pi}n=Dm(n,Cm.bind(null,e))}e.callbackPriority=t,e.callbackNode=n}}function Cm(e,t){if($i=-1,Ri=0,(Q&6)!==0)throw Error(C(327));var n=e.callbackNode;if(eo()&&e.callbackNode!==n)return null;var r=Li(e,e===Le?Fe:0);if(r===0)return null;if((r&30)!==0||(r&e.expiredLanes)!==0||t)t=Ji(e,r);else{t=r;var o=Q;Q|=2;var l=$m();(Le!==e||Fe!==t)&&(nn=null,so=we()+500,pr(e,t));do try{Qy();break}catch(s){Tm(e,s)}while(!0);Yu(),Xi.current=l,Q=o,Se!==null?t=0:(Le=null,Fe=0,t=Te)}if(t!==0){if(t===2&&(o=Ja(e),o!==0&&(r=o,t=Tu(e,o))),t===1)throw n=gl,pr(e,0),Rn(e,r),ut(e,we()),n;if(t===6)Rn(e,r);else{if(o=e.current.alternate,(r&30)===0&&!Wy(o)&&(t=Ji(e,r),t===2&&(l=Ja(e),l!==0&&(r=l,t=Tu(e,l))),t===1))throw n=gl,pr(e,0),Rn(e,r),ut(e,we()),n;switch(e.finishedWork=o,e.finishedLanes=r,t){case 0:case 1:throw Error(C(345));case 2:ur(e,lt,nn);break;case 3:if(Rn(e,r),(r&130023424)===r&&(t=cc+500-we(),10<t)){if(Li(e,0)!==0)break;if(o=e.suspendedLanes,(o&r)!==r){Je(),e.pingedLanes|=e.suspendedLanes&o;break}e.timeoutHandle=su(ur.bind(null,e,lt,nn),t);break}ur(e,lt,nn);break;case 4:if(Rn(e,r),(r&4194240)===r)break;for(t=e.eventTimes,o=-1;0<r;){var i=31-Ot(r);l=1<<i,i=t[i],i>o&&(o=i),r&=~l}if(r=o,r=we()-r,r=(120>r?120:480>r?480:1080>r?1080:1920>r?1920:3e3>r?3e3:4320>r?4320:1960*Hy(r/1960))-r,10<r){e.timeoutHandle=su(ur.bind(null,e,lt,nn),r);break}ur(e,lt,nn);break;case 5:ur(e,lt,nn);break;default:throw Error(C(329))}}}return ut(e,we()),e.callbackNode===n?Cm.bind(null,e):null}function Tu(e,t){var n=qo;return e.current.memoizedState.isDehydrated&&(pr(e,t).flags|=256),e=Ji(e,t),e!==2&&(t=lt,lt=n,t!==null&&$u(t)),e}function $u(e){lt===null?lt=e:lt.push.apply(lt,e)}function Wy(e){for(var t=e;;){if(t.flags&16384){var n=t.updateQueue;if(n!==null&&(n=n.stores,n!==null))for(var r=0;r<n.length;r++){var o=n[r],l=o.getSnapshot;o=o.value;try{if(!Mt(l(),o))return!1}catch{return!1}}}if(n=t.child,t.subtreeFlags&16384&&n!==null)n.return=t,t=n;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Rn(e,t){for(t&=~uc,t&=~cs,e.suspendedLanes|=t,e.pingedLanes&=~t,e=e.expirationTimes;0<t;){var n=31-Ot(t),r=1<<n;e[n]=-1,t&=~r}}function zf(e){if((Q&6)!==0)throw Error(C(327));eo();var t=Li(e,0);if((t&1)===0)return ut(e,we()),null;var n=Ji(e,t);if(e.tag!==0&&n===2){var r=Ja(e);r!==0&&(t=r,n=Tu(e,r))}if(n===1)throw n=gl,pr(e,0),Rn(e,t),ut(e,we()),n;if(n===6)throw Error(C(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,ur(e,lt,nn),ut(e,we()),null}function dc(e,t){var n=Q;Q|=1;try{return e(t)}finally{Q=n,Q===0&&(so=we()+500,is&&Wn())}}function xr(e){Nn!==null&&Nn.tag===0&&(Q&6)===0&&eo();var t=Q;Q|=1;var n=At.transition,r=ee;try{if(At.transition=null,ee=1,e)return e()}finally{ee=r,At.transition=n,Q=t,(Q&6)===0&&Wn()}}function fc(){pt=Kr.current,le(Kr)}function pr(e,t){e.finishedWork=null,e.finishedLanes=0;var n=e.timeoutHandle;if(n!==-1&&(e.timeoutHandle=-1,wy(n)),Se!==null)for(n=Se.return;n!==null;){var r=n;switch(Qu(r),r.tag){case 1:r=r.type.childContextTypes,r!=null&&Fi();break;case 3:lo(),le(st),le(Ke),tc();break;case 5:ec(r);break;case 4:lo();break;case 13:le(fe);break;case 19:le(fe);break;case 10:Xu(r.type._context);break;case 22:case 23:fc()}n=n.return}if(Le=e,Se=e=Mn(e.current,null),Fe=pt=t,Te=0,gl=null,uc=cs=vr=0,lt=qo=null,dr!==null){for(t=0;t<dr.length;t++)if(n=dr[t],r=n.interleaved,r!==null){n.interleaved=null;var o=r.next,l=n.pending;if(l!==null){var i=l.next;l.next=o,r.next=i}n.pending=r}dr=null}return e}function Tm(e,t){do{var n=Se;try{if(Yu(),Ai.current=Yi,Ki){for(var r=pe.memoizedState;r!==null;){var o=r.queue;o!==null&&(o.pending=null),r=r.next}Ki=!1}if(yr=0,Pe=Ce=pe=null,Xo=!1,pl=0,ac.current=null,n===null||n.return===null){Te=1,gl=t,Se=null;break}e:{var l=e,i=n.return,s=n,a=t;if(t=Fe,s.flags|=32768,a!==null&&typeof a=="object"&&typeof a.then=="function"){var c=a,h=s,p=h.tag;if((h.mode&1)===0&&(p===0||p===11||p===15)){var g=h.alternate;g?(h.updateQueue=g.updateQueue,h.memoizedState=g.memoizedState,h.lanes=g.lanes):(h.updateQueue=null,h.memoizedState=null)}var w=bf(i);if(w!==null){w.flags&=-257,Ef(w,i,s,l,t),w.mode&1&&Sf(l,c,t),t=w,a=c;var v=t.updateQueue;if(v===null){var k=new Set;k.add(a),t.updateQueue=k}else v.add(a);break e}else{if((t&1)===0){Sf(l,c,t),pc();break e}a=Error(C(426))}}else if(ae&&s.mode&1){var R=bf(i);if(R!==null){(R.flags&65536)===0&&(R.flags|=256),Ef(R,i,s,l,t),Gu(io(a,s));break e}}l=a=io(a,s),Te!==4&&(Te=2),qo===null?qo=[l]:qo.push(l),l=i;do{switch(l.tag){case 3:l.flags|=65536,t&=-t,l.lanes|=t;var d=cm(l,a,t);gf(l,d);break e;case 1:s=a;var u=l.type,f=l.stateNode;if((l.flags&128)===0&&(typeof u.getDerivedStateFromError=="function"||f!==null&&typeof f.componentDidCatch=="function"&&(On===null||!On.has(f)))){l.flags|=65536,t&=-t,l.lanes|=t;var x=dm(l,s,t);gf(l,x);break e}}l=l.return}while(l!==null)}_m(n)}catch(S){t=S,Se===n&&n!==null&&(Se=n=n.return);continue}break}while(!0)}function $m(){var e=Xi.current;return Xi.current=Yi,e===null?Yi:e}function pc(){(Te===0||Te===3||Te===2)&&(Te=4),Le===null||(vr&268435455)===0&&(cs&268435455)===0||Rn(Le,Fe)}function Ji(e,t){var n=Q;Q|=2;var r=$m();(Le!==e||Fe!==t)&&(nn=null,pr(e,t));do try{Uy();break}catch(o){Tm(e,o)}while(!0);if(Yu(),Q=n,Xi.current=r,Se!==null)throw Error(C(261));return Le=null,Fe=0,Te}function Uy(){for(;Se!==null;)Rm(Se)}function Qy(){for(;Se!==null&&!xg();)Rm(Se)}function Rm(e){var t=Im(e.alternate,e,pt);e.memoizedProps=e.pendingProps,t===null?_m(e):Se=t,ac.current=null}function _m(e){var t=e;do{var n=t.alternate;if(e=t.return,(t.flags&32768)===0){if(n=By(n,t,pt),n!==null){Se=n;return}}else{if(n=My(n,t),n!==null){n.flags&=32767,Se=n;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{Te=6,Se=null;return}}if(t=t.sibling,t!==null){Se=t;return}Se=t=e}while(t!==null);Te===0&&(Te=5)}function ur(e,t,n){var r=ee,o=At.transition;try{At.transition=null,ee=1,Gy(e,t,n,r)}finally{At.transition=o,ee=r}return null}function Gy(e,t,n,r){do eo();while(Nn!==null);if((Q&6)!==0)throw Error(C(327));n=e.finishedWork;var o=e.finishedLanes;if(n===null)return null;if(e.finishedWork=null,e.finishedLanes=0,n===e.current)throw Error(C(177));e.callbackNode=null,e.callbackPriority=0;var l=n.lanes|n.childLanes;if(Rg(e,l),e===Le&&(Se=Le=null,Fe=0),(n.subtreeFlags&2064)===0&&(n.flags&2064)===0||wi||(wi=!0,Dm(Pi,function(){return eo(),null})),l=(n.flags&15990)!==0,(n.subtreeFlags&15990)!==0||l){l=At.transition,At.transition=null;var i=ee;ee=1;var s=Q;Q|=4,ac.current=null,jy(e,n),Em(n,e),hy(lu),zi=!!ou,lu=ou=null,e.current=n,Vy(n,e,o),wg(),Q=s,ee=i,At.transition=l}else e.current=n;if(wi&&(wi=!1,Nn=e,qi=o),l=e.pendingLanes,l===0&&(On=null),bg(n.stateNode,r),ut(e,we()),t!==null)for(r=e.onRecoverableError,n=0;n<t.length;n++)o=t[n],r(o.value,{componentStack:o.stack,digest:o.digest});if(Zi)throw Zi=!1,e=Au,Au=null,e;return(qi&1)!==0&&e.tag!==0&&eo(),l=e.pendingLanes,(l&1)!==0?e===Cu?Jo++:(Jo=0,Cu=e):Jo=0,Wn(),null}function eo(){if(Nn!==null){var e=cp(qi),t=At.transition,n=ee;try{if(At.transition=null,ee=16>e?16:e,Nn===null)var r=!1;else{if(e=Nn,Nn=null,qi=0,(Q&6)!==0)throw Error(C(331));var o=Q;for(Q|=4,_=e.current;_!==null;){var l=_,i=l.child;if((_.flags&16)!==0){var s=l.deletions;if(s!==null){for(var a=0;a<s.length;a++){var c=s[a];for(_=c;_!==null;){var h=_;switch(h.tag){case 0:case 11:case 15:Zo(8,h,l)}var p=h.child;if(p!==null)p.return=h,_=p;else for(;_!==null;){h=_;var g=h.sibling,w=h.return;if(km(h),h===c){_=null;break}if(g!==null){g.return=w,_=g;break}_=w}}}var v=l.alternate;if(v!==null){var k=v.child;if(k!==null){v.child=null;do{var R=k.sibling;k.sibling=null,k=R}while(k!==null)}}_=l}}if((l.subtreeFlags&2064)!==0&&i!==null)i.return=l,_=i;else e:for(;_!==null;){if(l=_,(l.flags&2048)!==0)switch(l.tag){case 0:case 11:case 15:Zo(9,l,l.return)}var d=l.sibling;if(d!==null){d.return=l.return,_=d;break e}_=l.return}}var u=e.current;for(_=u;_!==null;){i=_;var f=i.child;if((i.subtreeFlags&2064)!==0&&f!==null)f.return=i,_=f;else e:for(i=u;_!==null;){if(s=_,(s.flags&2048)!==0)try{switch(s.tag){case 0:case 11:case 15:us(9,s)}}catch(S){ve(s,s.return,S)}if(s===i){_=null;break e}var x=s.sibling;if(x!==null){x.return=s.return,_=x;break e}_=s.return}}if(Q=o,Wn(),Kt&&typeof Kt.onPostCommitFiberRoot=="function")try{Kt.onPostCommitFiberRoot(ts,e)}catch{}r=!0}return r}finally{ee=n,At.transition=t}}return!1}function Of(e,t,n){t=io(n,t),t=cm(e,t,1),e=zn(e,t,1),t=Je(),e!==null&&(yl(e,1,t),ut(e,t))}function ve(e,t,n){if(e.tag===3)Of(e,e,n);else for(;t!==null;){if(t.tag===3){Of(t,e,n);break}else if(t.tag===1){var r=t.stateNode;if(typeof t.type.getDerivedStateFromError=="function"||typeof r.componentDidCatch=="function"&&(On===null||!On.has(r))){e=io(n,e),e=dm(t,e,1),t=zn(t,e,1),e=Je(),t!==null&&(yl(t,1,e),ut(t,e));break}}t=t.return}}function Ky(e,t,n){var r=e.pingCache;r!==null&&r.delete(t),t=Je(),e.pingedLanes|=e.suspendedLanes&n,Le===e&&(Fe&n)===n&&(Te===4||Te===3&&(Fe&130023424)===Fe&&500>we()-cc?pr(e,0):uc|=n),ut(e,t)}function Nm(e,t){t===0&&((e.mode&1)===0?t=1:(t=ii,ii<<=1,(ii&130023424)===0&&(ii=4194304)));var n=Je();e=cn(e,t),e!==null&&(yl(e,t,n),ut(e,n))}function Yy(e){var t=e.memoizedState,n=0;t!==null&&(n=t.retryLane),Nm(e,n)}function Xy(e,t){var n=0;switch(e.tag){case 13:var r=e.stateNode,o=e.memoizedState;o!==null&&(n=o.retryLane);break;case 19:r=e.stateNode;break;default:throw Error(C(314))}r!==null&&r.delete(t),Nm(e,n)}var Im;Im=function(e,t,n){if(e!==null)if(e.memoizedProps!==t.pendingProps||st.current)it=!0;else{if((e.lanes&n)===0&&(t.flags&128)===0)return it=!1,Oy(e,t,n);it=(e.flags&131072)!==0}else it=!1,ae&&(t.flags&1048576)!==0&&zp(t,Hi,t.index);switch(t.lanes=0,t.tag){case 2:var r=t.type;Ti(e,t),e=t.pendingProps;var o=no(t,Ke.current);Jr(t,n),o=rc(null,t,r,e,o,n);var l=oc();return t.flags|=1,typeof o=="object"&&o!==null&&typeof o.render=="function"&&o.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,at(r)?(l=!0,ji(t)):l=!1,t.memoizedState=o.state!==null&&o.state!==void 0?o.state:null,qu(t),o.updater=as,t.stateNode=o,o._reactInternals=t,mu(t,r,e,n),t=yu(null,t,r,!0,l,n)):(t.tag=0,ae&&l&&Uu(t),qe(null,t,o,n),t=t.child),t;case 16:r=t.elementType;e:{switch(Ti(e,t),e=t.pendingProps,o=r._init,r=o(r._payload),t.type=r,o=t.tag=qy(r),e=Pt(r,e),o){case 0:t=gu(null,t,r,e,n);break e;case 1:t=Tf(null,t,r,e,n);break e;case 11:t=Af(null,t,r,e,n);break e;case 14:t=Cf(null,t,r,Pt(r.type,e),n);break e}throw Error(C(306,r,""))}return t;case 0:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:Pt(r,o),gu(e,t,r,o,n);case 1:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:Pt(r,o),Tf(e,t,r,o,n);case 3:e:{if(hm(t),e===null)throw Error(C(387));r=t.pendingProps,l=t.memoizedState,o=l.element,Vp(e,t),Qi(t,r,null,n);var i=t.memoizedState;if(r=i.element,l.isDehydrated)if(l={element:r,isDehydrated:!1,cache:i.cache,pendingSuspenseBoundaries:i.pendingSuspenseBoundaries,transitions:i.transitions},t.updateQueue.baseState=l,t.memoizedState=l,t.flags&256){o=io(Error(C(423)),t),t=$f(e,t,r,n,o);break e}else if(r!==o){o=io(Error(C(424)),t),t=$f(e,t,r,n,o);break e}else for(mt=Ln(t.stateNode.containerInfo.firstChild),ht=t,ae=!0,zt=null,n=Fp(t,null,r,n),t.child=n;n;)n.flags=n.flags&-3|4096,n=n.sibling;else{if(ro(),r===o){t=dn(e,t,n);break e}qe(e,t,r,n)}t=t.child}return t;case 5:return Hp(t),e===null&&du(t),r=t.type,o=t.pendingProps,l=e!==null?e.memoizedProps:null,i=o.children,iu(r,o)?i=null:l!==null&&iu(r,l)&&(t.flags|=32),mm(e,t),qe(e,t,i,n),t.child;case 6:return e===null&&du(t),null;case 13:return gm(e,t,n);case 4:return Ju(t,t.stateNode.containerInfo),r=t.pendingProps,e===null?t.child=oo(t,null,r,n):qe(e,t,r,n),t.child;case 11:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:Pt(r,o),Af(e,t,r,o,n);case 7:return qe(e,t,t.pendingProps,n),t.child;case 8:return qe(e,t,t.pendingProps.children,n),t.child;case 12:return qe(e,t,t.pendingProps.children,n),t.child;case 10:e:{if(r=t.type._context,o=t.pendingProps,l=t.memoizedProps,i=o.value,re(Wi,r._currentValue),r._currentValue=i,l!==null)if(Mt(l.value,i)){if(l.children===o.children&&!st.current){t=dn(e,t,n);break e}}else for(l=t.child,l!==null&&(l.return=t);l!==null;){var s=l.dependencies;if(s!==null){i=l.child;for(var a=s.firstContext;a!==null;){if(a.context===r){if(l.tag===1){a=sn(-1,n&-n),a.tag=2;var c=l.updateQueue;if(c!==null){c=c.shared;var h=c.pending;h===null?a.next=a:(a.next=h.next,h.next=a),c.pending=a}}l.lanes|=n,a=l.alternate,a!==null&&(a.lanes|=n),fu(l.return,n,t),s.lanes|=n;break}a=a.next}}else if(l.tag===10)i=l.type===t.type?null:l.child;else if(l.tag===18){if(i=l.return,i===null)throw Error(C(341));i.lanes|=n,s=i.alternate,s!==null&&(s.lanes|=n),fu(i,n,t),i=l.sibling}else i=l.child;if(i!==null)i.return=l;else for(i=l;i!==null;){if(i===t){i=null;break}if(l=i.sibling,l!==null){l.return=i.return,i=l;break}i=i.return}l=i}qe(e,t,o.children,n),t=t.child}return t;case 9:return o=t.type,r=t.pendingProps.children,Jr(t,n),o=Ct(o),r=r(o),t.flags|=1,qe(e,t,r,n),t.child;case 14:return r=t.type,o=Pt(r,t.pendingProps),o=Pt(r.type,o),Cf(e,t,r,o,n);case 15:return fm(e,t,t.type,t.pendingProps,n);case 17:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:Pt(r,o),Ti(e,t),t.tag=1,at(r)?(e=!0,ji(t)):e=!1,Jr(t,n),um(t,r,o),mu(t,r,o,n),yu(null,t,r,!0,e,n);case 19:return ym(e,t,n);case 22:return pm(e,t,n)}throw Error(C(156,t.tag))};function Dm(e,t){return ip(e,t)}function Zy(e,t,n,r){this.tag=e,this.key=n,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=r,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Et(e,t,n,r){return new Zy(e,t,n,r)}function mc(e){return e=e.prototype,!(!e||!e.isReactComponent)}function qy(e){if(typeof e=="function")return mc(e)?1:0;if(e!=null){if(e=e.$$typeof,e===Du)return 11;if(e===Pu)return 14}return 2}function Mn(e,t){var n=e.alternate;return n===null?(n=Et(e.tag,t,e.key,e.mode),n.elementType=e.elementType,n.type=e.type,n.stateNode=e.stateNode,n.alternate=e,e.alternate=n):(n.pendingProps=t,n.type=e.type,n.flags=0,n.subtreeFlags=0,n.deletions=null),n.flags=e.flags&14680064,n.childLanes=e.childLanes,n.lanes=e.lanes,n.child=e.child,n.memoizedProps=e.memoizedProps,n.memoizedState=e.memoizedState,n.updateQueue=e.updateQueue,t=e.dependencies,n.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},n.sibling=e.sibling,n.index=e.index,n.ref=e.ref,n}function _i(e,t,n,r,o,l){var i=2;if(r=e,typeof e=="function")mc(e)&&(i=1);else if(typeof e=="string")i=5;else e:switch(e){case Br:return mr(n.children,o,l,t);case Iu:i=8,o|=8;break;case Ba:return e=Et(12,n,t,o|2),e.elementType=Ba,e.lanes=l,e;case Ma:return e=Et(13,n,t,o),e.elementType=Ma,e.lanes=l,e;case Fa:return e=Et(19,n,t,o),e.elementType=Fa,e.lanes=l,e;case Hf:return ds(n,o,l,t);default:if(typeof e=="object"&&e!==null)switch(e.$$typeof){case jf:i=10;break e;case Vf:i=9;break e;case Du:i=11;break e;case Pu:i=14;break e;case Cn:i=16,r=null;break e}throw Error(C(130,e==null?e:typeof e,""))}return t=Et(i,n,t,o),t.elementType=e,t.type=r,t.lanes=l,t}function mr(e,t,n,r){return e=Et(7,e,r,t),e.lanes=n,e}function ds(e,t,n,r){return e=Et(22,e,r,t),e.elementType=Hf,e.lanes=n,e.stateNode={isHidden:!1},e}function La(e,t,n){return e=Et(6,e,null,t),e.lanes=n,e}function za(e,t,n){return t=Et(4,e.children!==null?e.children:[],e.key,t),t.lanes=n,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function Jy(e,t,n,r,o){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=xa(0),this.expirationTimes=xa(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=xa(0),this.identifierPrefix=r,this.onRecoverableError=o,this.mutableSourceEagerHydrationData=null}function hc(e,t,n,r,o,l,i,s,a){return e=new Jy(e,t,n,s,a),t===1?(t=1,l===!0&&(t|=8)):t=0,l=Et(3,null,null,t),e.current=l,l.stateNode=e,l.memoizedState={element:r,isDehydrated:n,cache:null,transitions:null,pendingSuspenseBoundaries:null},qu(l),e}function ev(e,t,n){var r=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:Or,key:r==null?null:""+r,children:e,containerInfo:t,implementation:n}}function Pm(e){if(!e)return jn;e=e._reactInternals;e:{if(kr(e)!==e||e.tag!==1)throw Error(C(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(at(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(C(171))}if(e.tag===1){var n=e.type;if(at(n))return Pp(e,n,t)}return t}function Lm(e,t,n,r,o,l,i,s,a){return e=hc(n,r,!0,e,o,l,i,s,a),e.context=Pm(null),n=e.current,r=Je(),o=Bn(n),l=sn(r,o),l.callback=t??null,zn(n,l,o),e.current.lanes=o,yl(e,o,r),ut(e,r),e}function fs(e,t,n,r){var o=t.current,l=Je(),i=Bn(o);return n=Pm(n),t.context===null?t.context=n:t.pendingContext=n,t=sn(l,i),t.payload={element:e},r=r===void 0?null:r,r!==null&&(t.callback=r),e=zn(o,t,i),e!==null&&(Bt(e,o,i,l),Ei(e,o,i)),i}function es(e){return e=e.current,e.child?(e.child.tag===5,e.child.stateNode):null}function Bf(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var n=e.retryLane;e.retryLane=n!==0&&n<t?n:t}}function gc(e,t){Bf(e,t),(e=e.alternate)&&Bf(e,t)}function tv(){return null}var zm=typeof reportError=="function"?reportError:function(e){console.error(e)};function yc(e){this._internalRoot=e}ps.prototype.render=yc.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(C(409));fs(e,t,null,null)};ps.prototype.unmount=yc.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;xr(function(){fs(null,e,null,null)}),t[un]=null}};function ps(e){this._internalRoot=e}ps.prototype.unstable_scheduleHydration=function(e){if(e){var t=pp();e={blockedOn:null,target:e,priority:t};for(var n=0;n<$n.length&&t!==0&&t<$n[n].priority;n++);$n.splice(n,0,e),n===0&&hp(e)}};function vc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function ms(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11&&(e.nodeType!==8||e.nodeValue!==" react-mount-point-unstable "))}function Mf(){}function nv(e,t,n,r,o){if(o){if(typeof r=="function"){var l=r;r=function(){var c=es(i);l.call(c)}}var i=Lm(t,r,e,0,null,!1,!1,"",Mf);return e._reactRootContainer=i,e[un]=i.current,al(e.nodeType===8?e.parentNode:e),xr(),i}for(;o=e.lastChild;)e.removeChild(o);if(typeof r=="function"){var s=r;r=function(){var c=es(a);s.call(c)}}var a=hc(e,0,!1,null,null,!1,!1,"",Mf);return e._reactRootContainer=a,e[un]=a.current,al(e.nodeType===8?e.parentNode:e),xr(function(){fs(t,a,n,r)}),a}function hs(e,t,n,r,o){var l=n._reactRootContainer;if(l){var i=l;if(typeof o=="function"){var s=o;o=function(){var a=es(i);s.call(a)}}fs(t,i,e,o)}else i=nv(n,t,e,o,r);return es(i)}dp=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var n=Ho(t.pendingLanes);n!==0&&(Ou(t,n|1),ut(t,we()),(Q&6)===0&&(so=we()+500,Wn()))}break;case 13:xr(function(){var r=cn(e,1);if(r!==null){var o=Je();Bt(r,e,1,o)}}),gc(e,1)}};Bu=function(e){if(e.tag===13){var t=cn(e,134217728);if(t!==null){var n=Je();Bt(t,e,134217728,n)}gc(e,134217728)}};fp=function(e){if(e.tag===13){var t=Bn(e),n=cn(e,t);if(n!==null){var r=Je();Bt(n,e,t,r)}gc(e,t)}};pp=function(){return ee};mp=function(e,t){var n=ee;try{return ee=e,t()}finally{ee=n}};Xa=function(e,t,n){switch(t){case"input":if(Ha(e,n),t=n.name,n.type==="radio"&&t!=null){for(n=e;n.parentNode;)n=n.parentNode;for(n=n.querySelectorAll("input[name="+JSON.stringify(""+t)+'][type="radio"]'),t=0;t<n.length;t++){var r=n[t];if(r!==e&&r.form===e.form){var o=ls(r);if(!o)throw Error(C(90));Uf(r),Ha(r,o)}}}break;case"textarea":Gf(e,n);break;case"select":t=n.value,t!=null&&Yr(e,!!n.multiple,t,!1)}};ep=dc;tp=xr;var rv={usingClientEntryPoint:!1,Events:[xl,Vr,ls,qf,Jf,dc]},Mo={findFiberByHostInstance:cr,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},ov={bundleType:Mo.bundleType,version:Mo.version,rendererPackageName:Mo.rendererPackageName,rendererConfig:Mo.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:fn.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=op(e),e===null?null:e.stateNode},findFiberByHostInstance:Mo.findFiberByHostInstance||tv,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(Fo=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Fo.isDisabled&&Fo.supportsFiber))try{ts=Fo.inject(ov),Kt=Fo}catch{}var Fo;vt.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=rv;vt.createPortal=function(e,t){var n=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!vc(t))throw Error(C(200));return ev(e,t,null,n)};vt.createRoot=function(e,t){if(!vc(e))throw Error(C(299));var n=!1,r="",o=zm;return t!=null&&(t.unstable_strictMode===!0&&(n=!0),t.identifierPrefix!==void 0&&(r=t.identifierPrefix),t.onRecoverableError!==void 0&&(o=t.onRecoverableError)),t=hc(e,1,!1,null,null,n,!1,r,o),e[un]=t.current,al(e.nodeType===8?e.parentNode:e),new yc(t)};vt.findDOMNode=function(e){if(e==null)return null;if(e.nodeType===1)return e;var t=e._reactInternals;if(t===void 0)throw typeof e.render=="function"?Error(C(188)):(e=Object.keys(e).join(","),Error(C(268,e)));return e=op(t),e=e===null?null:e.stateNode,e};vt.flushSync=function(e){return xr(e)};vt.hydrate=function(e,t,n){if(!ms(t))throw Error(C(200));return hs(null,e,t,!0,n)};vt.hydrateRoot=function(e,t,n){if(!vc(e))throw Error(C(405));var r=n!=null&&n.hydratedSources||null,o=!1,l="",i=zm;if(n!=null&&(n.unstable_strictMode===!0&&(o=!0),n.identifierPrefix!==void 0&&(l=n.identifierPrefix),n.onRecoverableError!==void 0&&(i=n.onRecoverableError)),t=Lm(t,null,e,1,n??null,o,!1,l,i),e[un]=t.current,al(e),r)for(e=0;e<r.length;e++)n=r[e],o=n._getVersion,o=o(n._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[n,o]:t.mutableSourceEagerHydrationData.push(n,o);return new ps(t)};vt.render=function(e,t,n){if(!ms(t))throw Error(C(200));return hs(null,e,t,!1,n)};vt.unmountComponentAtNode=function(e){if(!ms(e))throw Error(C(40));return e._reactRootContainer?(xr(function(){hs(null,null,e,!1,function(){e._reactRootContainer=null,e[un]=null})}),!0):!1};vt.unstable_batchedUpdates=dc;vt.unstable_renderSubtreeIntoContainer=function(e,t,n,r){if(!ms(n))throw Error(C(200));if(e==null||e._reactInternals===void 0)throw Error(C(38));return hs(e,t,n,!1,r)};vt.version="18.3.1-next-f1338f8080-20240426"});var xc=Ht((fw,Mm)=>{"use strict";function Bm(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Bm)}catch(e){console.error(e)}}Bm(),Mm.exports=Om()});var jm=Ht(wc=>{"use strict";var Fm=xc();wc.createRoot=Fm.createRoot,wc.hydrateRoot=Fm.hydrateRoot;var pw});var Hh=Ht((Jw,Vh)=>{"use strict";var Yv={name:"original",anchor:"#1034a6",anchorVisited:"#440381",borderDark:"#848584",borderDarkest:"#0a0a0a",borderLight:"#dfdfdf",borderLightest:"#fefefe",canvas:"#ffffff",canvasText:"#0a0a0a",canvasTextDisabled:"#848584",canvasTextDisabledShadow:"#fefefe",canvasTextInvert:"#fefefe",checkmark:"#0a0a0a",checkmarkDisabled:"#848584",desktopBackground:"#008080",flatDark:"#9e9e9e",flatLight:"#d8d8d8",focusSecondary:"#fefe03",headerBackground:"#060084",headerNotActiveBackground:"#7f787f",headerNotActiveText:"#c6c6c6",headerText:"#fefefe",hoverBackground:"#060084",material:"#c6c6c6",materialDark:"#9a9e9c",materialText:"#0a0a0a",materialTextDisabled:"#848584",materialTextDisabledShadow:"#fefefe",materialTextInvert:"#fefefe",progress:"#060084",tooltip:"#fefbcc"};Vh.exports=Yv});var D0=Ht(Xs=>{"use strict";/**
 * @license React
 * react-jsx-runtime.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var Yx=L(),Xx=Symbol.for("react.element"),Zx=Symbol.for("react.fragment"),qx=Object.prototype.hasOwnProperty,Jx=Yx.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,ew={key:!0,ref:!0,__self:!0,__source:!0};function I0(e,t,n){var r,o={},l=null,i=null;n!==void 0&&(l=""+n),t.key!==void 0&&(l=""+t.key),t.ref!==void 0&&(i=t.ref);for(r in t)qx.call(t,r)&&!ew.hasOwnProperty(r)&&(o[r]=t[r]);if(e&&e.defaultProps)for(r in t=e.defaultProps,t)o[r]===void 0&&(o[r]=t[r]);return{$$typeof:Xx,type:e,key:l,ref:i,props:o,_owner:Jx.current}}Xs.Fragment=Zx;Xs.jsx=I0;Xs.jsxs=I0});var rd=Ht((EA,P0)=>{"use strict";P0.exports=D0()});var od=D(L(),1),L0=D(jm(),1);var ze=D(L());var te="-ms-",Sr="-moz-",G="-webkit-",gs="comm",Un="rule",co="decl";var Vm="@import";var Hm="@namespace",ys="@keyframes";var Wm="@layer";var kc=Math.abs,kl=String.fromCharCode,Sl=Object.assign;function Um(e,t){return he(e,0)^45?(((t<<2^he(e,0))<<2^he(e,1))<<2^he(e,2))<<2^he(e,3):0}function vs(e){return e.trim()}function Ft(e,t){return(e=t.exec(e))?e[0]:e}function z(e,t,n){return e.replace(t,n)}function fo(e,t,n){return e.indexOf(t,n)}function he(e,t){return e.charCodeAt(t)|0}function jt(e,t,n){return e.slice(t,n)}function Ye(e){return e.length}function xs(e){return e.length}function br(e,t){return t.push(e),e}function Qm(e,t){return e.map(t).join("")}function Sc(e,t){return e.filter(function(n){return!Ft(n,t)})}var ws=1,po=1,Gm=0,$t=0,be=0,ho="";function bl(e,t,n,r,o,l,i,s){return{value:e,root:t,parent:n,type:r,props:o,children:l,line:ws,column:po,length:i,return:"",siblings:s}}function pn(e,t){return Sl(bl("",null,null,"",null,null,0,e.siblings),e,{length:-e.length},t)}function Er(e){for(;e.root;)e=pn(e.root,{children:[e]});br(e,e.siblings)}function Km(){return be}function Ym(){return be=$t>0?he(ho,--$t):0,po--,be===10&&(po=1,ws--),be}function Rt(){return be=$t<Gm?he(ho,$t++):0,po++,be===10&&(po=1,ws++),be}function mn(){return he(ho,$t)}function El(){return $t}function ks(e,t){return jt(ho,e,t)}function mo(e){switch(e){case 0:case 9:case 10:case 13:case 32:return 5;case 33:case 43:case 44:case 47:case 62:case 64:case 126:case 59:case 123:case 125:return 4;case 58:return 3;case 34:case 39:case 40:case 91:return 2;case 41:case 93:return 1}return 0}function Xm(e){return ws=po=1,Gm=Ye(ho=e),$t=0,[]}function Zm(e){return ho="",e}function Ss(e){return vs(ks($t-1,bc(e===91?e+2:e===40?e+1:e)))}function qm(e){for(;(be=mn())&&be<33;)Rt();return mo(e)>2||mo(be)>3?"":" "}function Jm(e,t){for(;--t&&Rt()&&!(be<48||be>102||be>57&&be<65||be>70&&be<97););return ks(e,El()+(t<6&&mn()==32&&Rt()==32))}function bc(e){for(;Rt();)switch(be){case e:return $t;case 34:case 39:e!==34&&e!==39&&bc(be);break;case 40:e===41&&bc(e);break;case 92:Rt();break}return $t}function eh(e,t){for(;Rt()&&e+be!==57;)if(e+be===84&&mn()===47)break;return"/*"+ks(t,$t-1)+"*"+kl(e===47?e:Rt())}function th(e){for(;!mo(mn());)Rt();return ks(e,$t)}function oh(e){return Zm(bs("",null,null,null,[""],e=Xm(e),0,[0],e))}function bs(e,t,n,r,o,l,i,s,a){for(var c=0,h=0,p=i,g=0,w=0,v=0,k=1,R=1,d=1,u=0,f="",x=o,S=l,E=r,b=f;R;)switch(v=u,u=Rt()){case 40:if(v!=108&&he(b,p-1)==58){fo(b+=z(Ss(u),"&","&\f"),"&\f",kc(c?s[c-1]:0))!=-1&&(d=-1);break}case 34:case 39:case 91:b+=Ss(u);break;case 9:case 10:case 13:case 32:b+=qm(v);break;case 92:b+=Jm(El()-1,7);continue;case 47:switch(mn()){case 42:case 47:br(lv(eh(Rt(),El()),t,n,a),a),(mo(v||1)==5||mo(mn()||1)==5)&&Ye(b)&&jt(b,-1,void 0)!==" "&&(b+=" ");break;default:b+="/"}break;case 123*k:s[c++]=Ye(b)*d;case 125*k:case 59:case 0:switch(u){case 0:case 125:R=0;case 59+h:d==-1&&(b=z(b,/\f/g,"")),w>0&&(Ye(b)-p||k===0&&v===47)&&br(w>32?rh(b+";",r,n,p-1,a):rh(z(b," ","")+";",r,n,p-2,a),a);break;case 59:b+=";";default:if(br(E=nh(b,t,n,c,h,o,s,f,x=[],S=[],p,l),l),u===123)if(h===0)bs(b,t,E,E,x,l,p,s,S);else{switch(g){case 99:if(he(b,3)===110)break;case 108:if(he(b,2)===97)break;default:h=0;case 100:case 109:case 115:}h?bs(e,E,E,r&&br(nh(e,E,E,0,0,o,s,f,o,x=[],p,S),S),o,S,p,s,r?x:S):bs(b,E,E,E,[""],S,0,s,S)}}c=h=w=0,k=d=1,f=b="",p=i;break;case 58:p=1+Ye(b),w=v;default:if(k<1){if(u==123)--k;else if(u==125&&k++==0&&Ym()==125)continue}switch(b+=kl(u),u*k){case 38:d=h>0?1:(b+="\f",-1);break;case 44:s[c++]=(Ye(b)-1)*d,d=1;break;case 64:mn()===45&&(b+=Ss(Rt())),g=mn(),h=p=Ye(f=b+=th(El())),u++;break;case 45:v===45&&Ye(b)==2&&(k=0)}}return l}function nh(e,t,n,r,o,l,i,s,a,c,h,p){for(var g=o-1,w=o===0?l:[""],v=xs(w),k=0,R=0,d=0;k<r;++k)for(var u=0,f=jt(e,g+1,g=kc(R=i[k])),x=e;u<v;++u)(x=vs(R>0?w[u]+" "+f:z(f,/&\f/g,w[u])))&&(a[d++]=x);return bl(e,t,n,o===0?Un:s,a,c,h,p)}function lv(e,t,n,r){return bl(e,t,n,gs,kl(Km()),jt(e,2,-2),0,r)}function rh(e,t,n,r,o){return bl(e,t,n,co,jt(e,0,r),jt(e,r+1,-1),r,o)}function Ec(e,t,n){switch(Um(e,t)){case 5103:return G+"print-"+e+e;case 5737:case 4201:case 3177:case 3433:case 1641:case 4457:case 2921:case 5572:case 6356:case 5844:case 3191:case 6645:case 3005:case 4215:case 6389:case 5109:case 5365:case 5621:case 3829:case 6391:case 5879:case 5623:case 6135:case 4599:return G+e+e;case 4855:return G+e.replace("add","source-over").replace("substract","source-out").replace("intersect","source-in").replace("exclude","xor")+e;case 4789:return Sr+e+e;case 5349:case 4246:case 4810:case 6968:case 2756:return G+e+Sr+e+te+e+e;case 5936:switch(he(e,t+11)){case 114:return G+e+te+z(e,/[svh]\w+-[tblr]{2}/,"tb")+e;case 108:return G+e+te+z(e,/[svh]\w+-[tblr]{2}/,"tb-rl")+e;case 45:return G+e+te+z(e,/[svh]\w+-[tblr]{2}/,"lr")+e}case 6828:case 4268:case 2903:return G+e+te+e+e;case 6165:return G+e+te+"flex-"+e+e;case 5187:return G+e+z(e,/(\w+).+(:[^]+)/,G+"box-$1$2"+te+"flex-$1$2")+e;case 5443:return G+e+te+"flex-item-"+z(e,/flex-|-self/g,"")+(Ft(e,/flex-|baseline/)?"":te+"grid-row-"+z(e,/flex-|-self/g,""))+e;case 4675:return G+e+te+"flex-line-pack"+z(e,/align-content|flex-|-self/g,"")+e;case 5548:return G+e+te+z(e,"shrink","negative")+e;case 5292:return G+e+te+z(e,"basis","preferred-size")+e;case 6060:return G+"box-"+z(e,"-grow","")+G+e+te+z(e,"grow","positive")+e;case 4554:return G+z(e,/([^-])(transform)/g,"$1"+G+"$2")+e;case 6187:return z(z(z(e,/(zoom-|grab)/,G+"$1"),/(image-set)/,G+"$1"),e,"")+e;case 5495:case 3959:return z(e,/(image-set\([^]*)/,G+"$1$`$1");case 4968:return z(z(e,/(.+:)(flex-)?(.*)/,G+"box-pack:$3"+te+"flex-pack:$3"),/space-between/,"justify")+G+e+e;case 4200:if(!Ft(e,/flex-|baseline/))return te+"grid-column-align"+jt(e,t)+e;break;case 2592:case 3360:return te+z(e,"template-","")+e;case 4384:case 3616:return n&&n.some(function(r,o){return t=o,Ft(r.props,/grid-\w+-end/)})?~fo(e+(n=n[t].value),"span",0)?e:te+z(e,"-start","")+e+te+"grid-row-span:"+(~fo(n,"span",0)?Ft(n,/\d+/):+Ft(n,/\d+/)-+Ft(e,/\d+/))+";":te+z(e,"-start","")+e;case 4896:case 4128:return n&&n.some(function(r){return Ft(r.props,/grid-\w+-start/)})?e:te+z(z(e,"-end","-span"),"span ","")+e;case 4095:case 3583:case 4068:case 2532:return z(e,/(.+)-inline(.+)/,G+"$1$2")+e;case 8116:case 7059:case 5753:case 5535:case 5445:case 5701:case 4933:case 4677:case 5533:case 5789:case 5021:case 4765:if(Ye(e)-1-t>6)switch(he(e,t+1)){case 109:if(he(e,t+4)!==45)break;case 102:return z(e,/(.+:)(.+)-([^]+)/,"$1"+G+"$2-$3$1"+Sr+(he(e,t+3)==108?"$3":"$2-$3"))+e;case 115:return~fo(e,"stretch",0)?Ec(z(e,"stretch","fill-available"),t,n)+e:e}break;case 5152:case 5920:return z(e,/(.+?):(\d+)(\s*\/\s*(span)?\s*(\d+))?(.*)/,function(r,o,l,i,s,a,c){return te+o+":"+l+c+(i?te+o+"-span:"+(s?a:+a-+l)+c:"")+e});case 4949:if(he(e,t+6)===121)return z(e,":",":"+G)+e;break;case 6444:switch(he(e,he(e,14)===45?18:11)){case 120:return z(e,/(.+:)([^;\s!]+)(;|(\s+)?!.+)?/,"$1"+G+(he(e,14)===45?"inline-":"")+"box$3$1"+G+"$2$3$1"+te+"$2box$3")+e;case 100:return z(e,":",":"+te)+e}break;case 5719:case 2647:case 2135:case 3927:case 2391:return z(e,"scroll-","scroll-snap-")+e}return e}function go(e,t){for(var n="",r=0;r<e.length;r++)n+=t(e[r],r,e,t)||"";return n}function lh(e,t,n,r){switch(e.type){case Wm:if(e.children.length)break;case Vm:case Hm:case co:return e.return=e.return||e.value;case gs:return"";case ys:return e.return=e.value+"{"+go(e.children,r)+"}";case Un:if(!Ye(e.value=e.props.join(",")))return""}return Ye(n=go(e.children,r))?e.return=e.value+"{"+n+"}":""}function ih(e){var t=xs(e);return function(n,r,o,l){for(var i="",s=0;s<t;s++)i+=e[s](n,r,o,l)||"";return i}}function sh(e){return function(t){t.root||(t=t.return)&&e(t)}}function ah(e,t,n,r){if(e.length>-1&&!e.return)switch(e.type){case co:e.return=Ec(e.value,e.length,n);return;case ys:return go([pn(e,{value:z(e.value,"@","@"+G)})],r);case Un:if(e.length)return Qm(n=e.props,function(o){switch(Ft(o,r=/(::plac\w+|:read-\w+)/)){case":read-only":case":read-write":Er(pn(e,{props:[z(o,/:(read-\w+)/,":"+Sr+"$1")]})),Er(pn(e,{props:[o]})),Sl(e,{props:Sc(n,r)});break;case"::placeholder":Er(pn(e,{props:[z(o,/:(plac\w+)/,":"+G+"input-$1")]})),Er(pn(e,{props:[z(o,/:(plac\w+)/,":"+Sr+"$1")]})),Er(pn(e,{props:[z(o,/:(plac\w+)/,te+"input-$1")]})),Er(pn(e,{props:[o]})),Sl(e,{props:Sc(n,r)});break}return""})}}function Gn(e,...t){return new Error(`An error occurred. See https://github.com/styled-components/styled-components/blob/main/packages/styled-components/src/utils/errors.md#${e} for more information.${t.length>0?` Args: ${t.join(", ")}`:""}`)}var Ac,Cc,hn=typeof process<"u"&&process.env!==void 0&&(process.env.REACT_APP_SC_ATTR||process.env.SC_ATTR)||"data-styled",vh="active",xh="data-styled-version",$s="6.6.0",Bc=`/*!sc*/
`,Tl=typeof window<"u"&&typeof document<"u";if(!ze.default.createContext)throw Gn(19);function uh(e){if(typeof process<"u"&&process.env!==void 0){let t=process.env[e];if(t!==void 0&&t!=="")return t!=="false"}}var iv=!!(typeof SC_DISABLE_SPEEDY=="boolean"?SC_DISABLE_SPEEDY:(Cc=(Ac=uh("REACT_APP_SC_DISABLE_SPEEDY"))!==null&&Ac!==void 0?Ac:uh("SC_DISABLE_SPEEDY"))!==null&&Cc!==void 0?Cc:typeof process<"u"&&process.env!==void 0&&!1),sv="sc-keyframes-",av={},Hw=1<<30,As=new Map,Ts=new Map,Cs=1,Es=e=>{if(As.has(e))return As.get(e);for(;Ts.has(Cs);)Cs++;let t=Cs++;return As.set(e,t),Ts.set(t,e),t},uv=e=>Ts.get(e),cv=(e,t)=>{Cs=t+1,As.set(e,t),Ts.set(t,e)};var Mc=Object.freeze([]),yo=Object.freeze({});function wh(e,t,n=yo){return e.theme!==n.theme&&e.theme||t||n.theme}var dv=/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~-]+/g,fv=/(^-|-$)/g;function kh(e){return e.replace(dv,"-").replace(fv,"")}var pv=/(a)(d)/gi,ch=e=>String.fromCharCode(e+(e>25?39:97));function Sh(e){let t,n="";for(t=Math.abs(e);t>52;t=t/52|0)n=ch(t%52)+n;return(ch(t%52)+n).replace(pv,"$1-$2")}var _c=5381,Cr=(e,t)=>{let n=t.length;for(;n;)e=33*e^t.charCodeAt(--n);return e},bh=e=>Cr(_c,e);function Eh(e){return Sh(bh(e)>>>0)}function mv(e){return e.displayName||e.name||"Component"}function Nc(e){return typeof e=="string"&&!0}function hv(e){return Nc(e)?`styled.${e}`:`Styled(${mv(e)})`}var Ah=Symbol.for("react.memo"),gv=Symbol.for("react.forward_ref"),yv={contextType:!0,defaultProps:!0,displayName:!0,getDerivedStateFromError:!0,getDerivedStateFromProps:!0,propTypes:!0,type:!0},vv={name:!0,length:!0,prototype:!0,caller:!0,callee:!0,arguments:!0,arity:!0},Ch={$$typeof:!0,compare:!0,defaultProps:!0,displayName:!0,propTypes:!0,type:!0},xv={[gv]:{$$typeof:!0,render:!0,defaultProps:!0,displayName:!0,propTypes:!0},[Ah]:Ch};function dh(e){return("type"in(t=e)&&t.type.$$typeof)===Ah?Ch:"$$typeof"in e?xv[e.$$typeof]:yv;var t}var wv=Object.defineProperty,kv=Object.getOwnPropertyNames,Sv=Object.getOwnPropertySymbols,bv=Object.getOwnPropertyDescriptor,Ev=Object.getPrototypeOf,Av=Object.prototype;function Th(e,t,n){if(typeof t!="string"){let r=Ev(t);r&&r!==Av&&Th(e,r,n);let o=kv(t).concat(Sv(t)),l=dh(e),i=dh(t);for(let s=0;s<o.length;++s){let a=o[s];if(!(a in vv||n&&n[a]||i&&a in i||l&&a in l)){let c=bv(t,a);try{wv(e,a,c)}catch{}}}}return e}function vo(e){return typeof e=="function"}var Cv=Symbol.for("react.forward_ref");function Fc(e){return e!=null&&(typeof e=="object"||typeof e=="function")&&e.$$typeof===Cv&&"styledComponentId"in e}function Cl(e,t){return e&&t?e+" "+t:e||t||""}function Ic(e,t){return e.join(t||"")}function $l(e){return e!==null&&typeof e=="object"&&e.constructor.name===Object.name&&!("props"in e&&e.$$typeof)}function Dc(e,t,n=!1){if(!n&&!$l(e)&&!Array.isArray(e))return t;if(Array.isArray(t))for(let r=0;r<t.length;r++)e[r]=Dc(e[r],t[r]);else if($l(t))for(let r in t)e[r]=Dc(e[r],t[r]);return e}function $h(e,t){Object.defineProperty(e,"toString",{value:t})}var Tv=class{constructor(e){this.groupSizes=new Uint32Array(512),this.length=512,this.tag=e,this._cGroup=0,this._cIndex=0}indexOfGroup(e){if(e===this._cGroup)return this._cIndex;let t=this._cIndex;if(e>this._cGroup)for(let n=this._cGroup;n<e;n++)t+=this.groupSizes[n];else for(let n=this._cGroup-1;n>=e;n--)t-=this.groupSizes[n];return this._cGroup=e,this._cIndex=t,t}insertRules(e,t){if(e>=this.groupSizes.length){let o=this.groupSizes,l=o.length,i=l;for(;e>=i;)if(i<<=1,i<0)throw Gn(16,`${e}`);this.groupSizes=new Uint32Array(i),this.groupSizes.set(o),this.length=i;for(let s=l;s<i;s++)this.groupSizes[s]=0}let n=this.indexOfGroup(e+1),r=0;for(let o=0,l=t.length;o<l;o++)this.tag.insertRule(n,t[o])&&(this.groupSizes[e]++,n++,r++);r>0&&this._cGroup>e&&(this._cIndex+=r)}clearGroup(e){if(e<this.length){let t=this.groupSizes[e],n=this.indexOfGroup(e),r=n+t;this.groupSizes[e]=0;for(let o=n;o<r;o++)this.tag.deleteRule(n);t>0&&this._cGroup>e&&(this._cIndex-=t)}}getGroup(e){let t="";if(e>=this.length||this.groupSizes[e]===0)return t;let n=this.groupSizes[e],r=this.indexOfGroup(e),o=r+n;for(let l=r;l<o;l++)t+=this.tag.getRule(l)+Bc;return t}},$v=`style[${hn}][${xh}="${$s}"]`,Rv=new RegExp(`^${hn}\\.g(\\d+)\\[id="([\\w\\d-]+)"\\].*?"([^"]*)`);var fh=e=>typeof ShadowRoot<"u"&&e instanceof ShadowRoot||"host"in e&&e.nodeType===11,Pc=e=>{if(!e)return document;if(fh(e))return e;if("getRootNode"in e){let t=e.getRootNode();if(fh(t))return t}return document},_v=(e,t,n)=>{let r=n.split(","),o;for(let l=0,i=r.length;l<i;l++)(o=r[l])&&e.registerName(t,o)},Nv=(e,t)=>{var n;let r=((n=t.textContent)!==null&&n!==void 0?n:"").split(Bc),o=[];for(let l=0,i=r.length;l<i;l++){let s=r[l].trim();if(!s)continue;let a=s.match(Rv);if(a){let c=0|parseInt(a[1],10),h=a[2];c!==0&&(cv(h,c),_v(e,h,a[3]),e.getTag().insertRules(c,o)),o.length=0}else o.push(s)}},Tc=e=>{let t=Pc(e.options.target),n=t.querySelectorAll($v);for(let r=0,o=n.length;r<o;r++){let l=n[r];l&&l.getAttribute(hn)!==vh&&(Nv(e,l),l.parentNode&&l.parentNode.removeChild(l))}},Al=!1;function Iv(){if(Al!==!1)return Al;if(typeof document<"u"){let e=document.head.querySelector('meta[property="csp-nonce"]');if(e)return Al=e.nonce||e.getAttribute("content")||void 0;let t=document.head.querySelector('meta[name="sc-nonce"]');if(t)return Al=t.getAttribute("content")||void 0}return Al=typeof __webpack_nonce__<"u"?__webpack_nonce__:void 0}var Rh=(e,t)=>{if(typeof document>"u")throw Gn(20);let n=document.head,r=e||n,o=document.createElement("style"),l=(a=>{let c=Array.from(a.querySelectorAll(`style[${hn}]`));return c[c.length-1]})(r),i=l!==void 0?l.nextSibling:null;o.setAttribute(hn,vh),o.setAttribute(xh,$s);let s=t||Iv();return s&&o.setAttribute("nonce",s),r.insertBefore(o,i),o},Dv=class{constructor(e,t){this.element=Rh(e,t),this.element.appendChild(document.createTextNode("")),this.sheet=(n=>{var r;if(n.sheet)return n.sheet;let o=(r=n.getRootNode().styleSheets)!==null&&r!==void 0?r:document.styleSheets;for(let l=0,i=o.length;l<i;l++){let s=o[l];if(s.ownerNode===n)return s}throw Gn(17)})(this.element),this.length=0}insertRule(e,t){try{return this.sheet.insertRule(t,e),this.length++,!0}catch{return!1}}deleteRule(e){this.sheet.deleteRule(e),this.length--}getRule(e){let t=this.sheet.cssRules[e];return t&&t.cssText?t.cssText:""}},Pv=class{constructor(e,t){this.element=Rh(e,t),this.nodes=this.element.childNodes,this.length=0}insertRule(e,t){if(e<=this.length&&e>=0){let n=document.createTextNode(t);return this.element.insertBefore(n,this.nodes[e]||null),this.length++,!0}return!1}deleteRule(e){this.element.removeChild(this.nodes[e]),this.length--}getRule(e){return e<this.length?this.nodes[e].textContent:""}},ph=Tl,Lv={isServer:!Tl,useCSSOMInjection:!iv},Rl=class e{static registerId(t){return Es(t)}constructor(t=yo,n={},r){this.options=Object.assign(Object.assign({},Lv),t),this.gs=n,this.keyframeIds=new Set,this.names=new Map(r),this.server=!!t.isServer,!this.server&&Tl&&ph&&(ph=!1,Tc(this)),$h(this,()=>(o=>{let l=o.getTag(),{length:i}=l,s="";for(let a=0;a<i;a++){let c=uv(a);if(c===void 0)continue;let h=o.names.get(c);if(h===void 0||!h.size)continue;let p=l.getGroup(a);if(p.length===0)continue;let g=hn+".g"+a+'[id="'+c+'"]',w="";for(let v of h)v.length>0&&(w+=v+",");s+=p+g+'{content:"'+w+'"}'+Bc}return s})(this))}rehydrate(){!this.server&&Tl&&Tc(this)}reconstructWithOptions(t,n=!0){let r=new e(Object.assign(Object.assign({},this.options),t),this.gs,n&&this.names||void 0);return r.keyframeIds=new Set(this.keyframeIds),!this.server&&Tl&&t.target!==this.options.target&&Pc(this.options.target)!==Pc(t.target)&&Tc(r),r}allocateGSInstance(t){return this.gs[t]=(this.gs[t]||0)+1}getTag(){return this.tag||(this.tag=(t=(({useCSSOMInjection:n,target:r,nonce:o})=>n?new Dv(r,o):new Pv(r,o))(this.options),new Tv(t)));var t}hasNameForId(t,n){var r,o;return(o=(r=this.names.get(t))===null||r===void 0?void 0:r.has(n))!==null&&o!==void 0&&o}registerName(t,n){Es(t),t.startsWith(sv)&&this.keyframeIds.add(t);let r=this.names.get(t);r?r.add(n):this.names.set(t,new Set([n]))}insertRules(t,n,r){this.registerName(t,n),this.getTag().insertRules(Es(t),r)}clearNames(t){this.names.has(t)&&this.names.get(t).clear()}clearRules(t){this.getTag().clearGroup(Es(t)),this.clearNames(t)}clearTag(){this.tag=void 0}},_h=new WeakSet,zv={animationIterationCount:1,aspectRatio:1,borderImageOutset:1,borderImageSlice:1,borderImageWidth:1,columnCount:1,columns:1,flex:1,flexGrow:1,flexShrink:1,gridRow:1,gridRowEnd:1,gridRowSpan:1,gridRowStart:1,gridColumn:1,gridColumnEnd:1,gridColumnSpan:1,gridColumnStart:1,fontWeight:1,lineHeight:1,opacity:1,order:1,orphans:1,scale:1,tabSize:1,widows:1,zIndex:1,zoom:1,WebkitLineClamp:1,fillOpacity:1,floodOpacity:1,stopOpacity:1,strokeDasharray:1,strokeDashoffset:1,strokeMiterlimit:1,strokeOpacity:1,strokeWidth:1};function Ov(e,t){return t==null||typeof t=="boolean"||t===""?"":typeof t!="number"||t===0||e in zv||e.startsWith("--")?String(t).trim():t+"px"}var Ar=47;function mh(e){if(e.charCodeAt(0)===45&&e.charCodeAt(1)===45)return e;let t="";for(let n=0;n<e.length;n++){let r=e.charCodeAt(n);t+=r>=65&&r<=90?"-"+String.fromCharCode(r+32):e[n]}return t.startsWith("ms-")?"-"+t:t}var Nh=Symbol.for("sc-keyframes");function Bv(e){return typeof e=="object"&&e!==null&&Nh in e}function Ih(e){return vo(e)&&!(e.prototype&&e.prototype.isReactComponent)}var Dh=e=>e==null||e===!1||e==="",Mv=Symbol.for("react.client.reference");function hh(e){return e.$$typeof===Mv}function Ph(e,t){for(let n in e){let r=e[n];e.hasOwnProperty(n)&&!Dh(r)&&(Array.isArray(r)&&_h.has(r)||vo(r)?t.push(mh(n)+":",r,";"):$l(r)?(t.push(n+" {"),Ph(r,t),t.push("}")):t.push(mh(n)+": "+Ov(n,r)+";"))}}function Qn(e,t,n,r,o=[]){if(Dh(e))return o;let l=typeof e;if(l==="string")return o.push(e),o;if(l==="function"){if(hh(e))return o;if(Ih(e)&&t){let i=e(t);return Qn(i,t,n,r,o)}return o.push(e),o}if(Array.isArray(e)){for(let i=0;i<e.length;i++)Qn(e[i],t,n,r,o);return o}return Fc(e)?(o.push(`.${e.styledComponentId}`),o):Bv(e)?(n?(e.inject(n,r),o.push(e.getName(r))):o.push(e),o):hh(e)?o:$l(e)?e.toString!==Object.prototype.toString?(o.push(e.toString()),o):(Ph(e,o),o):(o.push(e.toString()),o)}var Fv=bh($s),Lc=class{constructor(t,n,r){this.rules=t,this.componentId=n,this.baseHash=Cr(Fv,n),this.baseStyle=r,Rl.registerId(n)}generateAndInjectStyles(t,n,r){let o=this.baseStyle?this.baseStyle.generateAndInjectStyles(t,n,r):"";{let l="";for(let i=0;i<this.rules.length;i++){let s=this.rules[i];if(typeof s=="string")l+=s;else if(s)if(Ih(s)){let a=s(t);typeof a=="string"?l+=a:a!=null&&a!==!1&&(l+=Ic(Qn(a,t,n,r)))}else l+=Ic(Qn(s,t,n,r))}if(l){this.dynamicNameCache||(this.dynamicNameCache=new Map);let i=r.hash?r.hash+l:l,s=this.dynamicNameCache.get(i);if(!s){if(s=Sh(Cr(Cr(this.baseHash,r.hash),l)>>>0),this.dynamicNameCache.size>=200){let a=this.dynamicNameCache.keys().next().value;a!==void 0&&this.dynamicNameCache.delete(a)}this.dynamicNameCache.set(i,s)}if(!n.hasNameForId(this.componentId,s)){let a=r(l,"."+s,void 0,this.componentId);n.insertRules(this.componentId,s,a)}o=Cl(o,s)}}return o}},jv=/&/g;function Lh(e,t){let n=0;for(;--t>=0&&e.charCodeAt(t)===92;)n++;return!(1&~n)}function $c(e){let t=e.length,n="",r=0,o=0,l=0,i=!1,s=!1;for(let a=0;a<t;a++){let c=e.charCodeAt(a);if(l!==0||i||c!==Ar||e.charCodeAt(a+1)!==42)if(i)c===42&&e.charCodeAt(a+1)===Ar&&(i=!1,a++);else if(c!==34&&c!==39||Lh(e,a)){if(l===0)if(c===123)o++;else if(c===125){if(o--,o<0){s=!0;let h=a+1;for(;h<t;){let p=e.charCodeAt(h);if(p===59||p===10)break;h++}h<t&&e.charCodeAt(h)===59&&h++,o=0,a=h-1,r=h;continue}o===0&&(n+=e.substring(r,a+1),r=a+1)}else c===59&&o===0&&(n+=e.substring(r,a+1),r=a+1)}else l===0?l=c:l===c&&(l=0);else i=!0,a++}return s||o!==0||l!==0?(r<t&&o===0&&l===0&&(n+=e.substring(r)),n):e}function zh(e,t){let n=t+" ",r=","+n;for(let o=0;o<e.length;o++){let l=e[o];if(l.type==="rule"){l.value=(n+l.value).replaceAll(",",r);let i=l.props,s=[];for(let a=0;a<i.length;a++)s[a]=n+i[a];l.props=s}Array.isArray(l.children)&&l.type!=="@keyframes"&&zh(l.children,t)}return e}function Vv({options:e=yo,plugins:t=Mc}=yo){let n,r,o,l=(g,w,v)=>v.startsWith(r)&&v.endsWith(r)&&v.replaceAll(r,"").length>0?`.${n}`:g,i=t.slice();i.push(g=>{g.type===Un&&g.value.includes("&")&&(o||(o=new RegExp(`\\${r}\\b`,"g")),g.props[0]=g.props[0].replace(jv,r).replace(o,l))}),e.prefix&&i.push(ah),i.push(lh);let s=[],a=ih(i.concat(sh(g=>s.push(g)))),c=(g,w="",v="",k="&")=>{n=k,r=w,o=void 0;let R=(function(u){let f=u.indexOf("//")!==-1,x=u.indexOf("}")!==-1;if(!f&&!x)return u;if(!f)return $c(u);let S=u.length,E="",b=0,A=0,B=0,I=0,U=0,Z=!1;for(;A<S;){let q=u.charCodeAt(A);if(q!==34&&q!==39||Lh(u,A))if(B===0)if(q===Ar&&A+1<S&&u.charCodeAt(A+1)===42){for(A+=2;A+1<S&&(u.charCodeAt(A)!==42||u.charCodeAt(A+1)!==Ar);)A++;A+=2}else if(q!==40)if(q!==41)if(I>0)A++;else if(q===42&&A+1<S&&u.charCodeAt(A+1)===Ar)E+=u.substring(b,A),A+=2,b=A,Z=!0;else if(q===Ar&&A+1<S&&u.charCodeAt(A+1)===Ar){for(E+=u.substring(b,A);A<S&&u.charCodeAt(A)!==10;)A++;b=A,Z=!0}else q===123?U++:q===125&&U--,A++;else I>0&&I--,A++;else I++,A++;else A++;else B===0?B=q:B===q&&(B=0),A++}return Z?(b<S&&(E+=u.substring(b)),U===0?E:$c(E)):U===0?u:$c(u)})(g),d=oh(v||w?v+" "+w+" { "+R+" }":R);return e.namespace&&(d=zh(d,e.namespace)),s=[],go(d,a),s},h=e,p=_c;for(let g=0;g<t.length;g++)t[g].name||Gn(15),p=Cr(p,t[g].name);return h?.namespace&&(p=Cr(p,h.namespace)),h?.prefix&&(p=Cr(p,"p")),c.hash=p!==_c?p.toString():"",c}var Hv=new Rl,Wv=Vv(),Oh=ze.default.createContext({shouldForwardProp:void 0,styleSheet:Hv,stylis:Wv,stylisPlugins:void 0}),Ww=Oh.Consumer;function Bh(){return ze.default.useContext(Oh)}var _l=ze.default.createContext(void 0),Uw=_l.Consumer;function Mh(e){let t=ze.default.useContext(_l),n=ze.default.useMemo(()=>(function(r,o){if(!r)throw Gn(14);if(vo(r))return r(o);if(Array.isArray(r)||typeof r!="object")throw Gn(8);return o?Object.assign(Object.assign({},o),r):r})(e.theme,t),[e.theme,t]);return e.children?ze.default.createElement(_l.Provider,{value:n},e.children):null}var Rc={};function Uv(e,t){let n=typeof e!="string"?"sc":kh(e);Rc[n]=(Rc[n]||0)+1;let r=n+"-"+Eh($s+n+Rc[n]);return t?t+"-"+r:r}function Qv(e,t,n){let r=Fc(e),o=e,l=!Nc(e),{attrs:i=Mc,componentId:s=Uv(t.displayName,t.parentComponentId),displayName:a=hv(e)}=t,c=t.displayName&&t.componentId?kh(t.displayName)+"-"+t.componentId:t.componentId||s,h=r&&o.attrs?o.attrs.concat(i).filter(Boolean):i,{shouldForwardProp:p}=t;if(r&&o.shouldForwardProp){let k=o.shouldForwardProp;if(t.shouldForwardProp){let R=t.shouldForwardProp;p=(d,u)=>k(d,u)&&R(d,u)}else p=k}let g=new Lc(n,c,r?o.componentStyle:void 0);function w(k,R){return(function(d,u,f){let{attrs:x,componentStyle:S,defaultProps:E,foldedComponentIds:b,styledComponentId:A,target:B}=d,I=ze.default.useContext(_l),U=Bh(),Z=d.shouldForwardProp||U.shouldForwardProp,q=wh(u,I,E)||yo,[ce,xe]=(function(De,Ee,O){let N=Object.assign(Object.assign({},Ee),{className:void 0,theme:O}),K=null,V=De.length>1;for(let M=0;M<De.length;M++){let J=De[M],$=vo(J)?J(V?Object.assign({},N):N):J;for(let P in $)P==="className"?N.className=Cl(N.className,$[P]):P==="style"?N.style=Object.assign(Object.assign({},N.style),$[P]):$[P]===void 0?P in N&&(N[P]!==void 0&&(K||(K=[])).push(P),N[P]=void 0):N[P]=$[P]}return"className"in Ee&&typeof Ee.className=="string"&&(N.className=Cl(N.className,Ee.className)),[N,K]})(x,u,q),Ve=S.generateAndInjectStyles(ce,U.styleSheet,U.stylis),He=ce.as||B,j=Nc(He),ye=(function(De,Ee,O,N,K,V){let M={};for(let J in De)J[0]==="$"||J==="as"||J==="theme"&&De.theme===O||(J==="forwardedAs"?De.forwardedAs!==void 0&&(M.as=De.forwardedAs):De[J]===void 0?J==="className"||K||V!==null&&V.indexOf(J)!==-1||N&&!N(J,Ee)||(M[J]=void 0):N&&!N(J,Ee)||(M[J]=De[J]));return M})(ce,He,q,Z,j,xe),Oe=Cl(b,A);return Ve&&(Oe+=" "+Ve),ce.className&&(Oe+=" "+ce.className),ye[j&&He.includes("-")?"class":"className"]=Oe,f&&(ye.ref=f),(0,ze.createElement)(He,ye)})(v,k,R)}w.displayName=a;let v=ze.default.forwardRef(w);return v.attrs=h,v.componentStyle=g,v.displayName=a,v.shouldForwardProp=p,v.foldedComponentIds=r?Cl(o.foldedComponentIds,o.styledComponentId):"",v.styledComponentId=c,v.target=r?o.target:e,Object.defineProperty(v,"defaultProps",{get(){return this._foldedDefaultProps},set(k){this._foldedDefaultProps=r?(function(R,...d){for(let u of d)Dc(R,u,!0);return R})({},o.defaultProps,k):k}}),$h(v,()=>`.${v.styledComponentId}`),l&&Th(v,e,{attrs:!0,componentStyle:!0,displayName:!0,foldedComponentIds:!0,shouldForwardProp:!0,styledComponentId:!0,target:!0}),v}var Gv=new Set(["a","abbr","address","area","article","aside","audio","b","bdi","bdo","blockquote","body","button","br","canvas","caption","cite","code","col","colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl","dt","em","embed","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","header","hgroup","hr","html","i","iframe","img","input","ins","kbd","label","legend","li","main","map","mark","menu","meter","nav","object","ol","optgroup","option","output","p","picture","pre","progress","q","rp","rt","ruby","s","samp","search","section","select","slot","small","span","strong","sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead","time","tr","u","ul","var","video","wbr","circle","clipPath","defs","ellipse","feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feDropShadow","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence","filter","foreignObject","g","image","line","linearGradient","marker","mask","path","pattern","polygon","polyline","radialGradient","rect","stop","svg","switch","symbol","text","textPath","tspan","use"]);function gh(e,t){let n=[e[0]];for(let r=0,o=t.length;r<o;r+=1)n.push(t[r],e[r+1]);return n}var yh=e=>(_h.add(e),e);function T(e,...t){if(vo(e)||$l(e))return yh(Qn(gh(Mc,[e,...t])));let n=e;return t.length===0&&n.length===1&&typeof n[0]=="string"?Qn(n):yh(Qn(gh(n,t)))}function zc(e,t,n=yo){if(!t)throw Gn(1,t);let r=(o,...l)=>e(t,n,T(o,...l));return r.attrs=o=>zc(e,t,Object.assign(Object.assign({},n),{attrs:Array.prototype.concat(n.attrs,o).filter(Boolean)})),r.withConfig=o=>zc(e,t,Object.assign(Object.assign({},n),o)),r}var Fh=e=>zc(Qv,e),y=Fh;Gv.forEach(e=>{y[e]=Fh(e)});var Oc=class{constructor(t,n){this.instanceRules=new Map,this.rules=t,this.componentId=n,this.isStatic=(function(r){for(let o=0;o<r.length;o+=1){let l=r[o];if(vo(l)&&!Fc(l))return!1}return!0})(t),Rl.registerId(this.componentId)}removeStyles(t,n){this.instanceRules.delete(t),this.rebuildGroup(n)}renderStyles(t,n,r,o){let l=this.componentId;if(this.isStatic){if(r.hasNameForId(l,l+t))this.instanceRules.has(t)||this.computeRules(t,n,r,o);else{let s=this.computeRules(t,n,r,o);r.insertRules(l,s.name,s.rules)}return}let i=this.instanceRules.get(t);if(this.computeRules(t,n,r,o),!r.server&&i){let s=i.rules,a=this.instanceRules.get(t).rules;if(s.length===a.length){let c=!0;for(let h=0;h<s.length;h++)if(s[h]!==a[h]){c=!1;break}if(c)return}}this.rebuildGroup(r)}computeRules(t,n,r,o){let l=Ic(Qn(this.rules,n,r,o)),i={name:this.componentId+t,rules:o(l,"")};return this.instanceRules.set(t,i),i}rebuildGroup(t){let n=this.componentId;t.clearRules(n);for(let r of this.instanceRules.values())t.insertRules(n,r.name,r.rules)}};function jh(e,...t){let n=T(e,...t),r=`sc-global-${Eh(JSON.stringify(n))}`,o=new Oc(n,r),l=s=>{let a=Bh(),c=ze.default.useContext(_l),h;{let p=ze.default.useRef(null);p.current===null&&(p.current=a.styleSheet.allocateGSInstance(r)),h=p.current}a.styleSheet.server&&i(h,s,a.styleSheet,c,a.stylis);{let p=o.isStatic?[h,a.styleSheet,o]:[h,s,a.styleSheet,c,a.stylis,o],g=ze.default.useRef(o);ze.default.useLayoutEffect(()=>{a.styleSheet.server||(g.current!==o&&(a.styleSheet.clearRules(r),g.current=o),i(h,s,a.styleSheet,c,a.stylis))},p),ze.default.useLayoutEffect(()=>()=>{a.styleSheet.server||o.removeStyles(h,a.styleSheet)},[h,a.styleSheet,o])}return a.styleSheet.server&&o.instanceRules.delete(h),null};function i(s,a,c,h,p){if(o.isStatic)o.renderStyles(s,av,c,p);else{let g=Object.assign(Object.assign({},a),{theme:wh(a,h,l.defaultProps)});o.renderStyles(s,g,c,p)}}return ze.default.memo(l)}var Kv;Kv=Nh;var Qw=`__sc-${hn}__`;var Gw=`:not(style[${hn}])`,Kw=`style[${hn}]`;var ld=D(Hh(),1);var Nl="4px 4px 10px 0 rgba(0, 0, 0, 0.35)",Il="inset 2px 2px 3px rgba(0,0,0,0.2)",Re=()=>T`
  -webkit-text-fill-color: ${({theme:e})=>e.materialTextDisabled};
  color: ${({theme:e})=>e.materialTextDisabled};
  text-shadow: 1px 1px ${({theme:e})=>e.materialTextDisabledShadow};
  /* filter: grayscale(100%); */
`,$e=({background:e="material",color:t="materialText"}={})=>T`
  box-sizing: border-box;
  display: inline-block;
  background: ${({theme:n})=>n[e]};
  color: ${({theme:n})=>n[t]};
`,gn=({mainColor:e="black",secondaryColor:t="transparent",pixelSize:n=2})=>T`
  background-image: ${[`linear-gradient(
      45deg,
      ${e} 25%,
      transparent 25%,
      transparent 75%,
      ${e} 75%
    )`,`linear-gradient(
      45deg,
      ${e} 25%,
      transparent 25%,
      transparent 75%,
      ${e} 75%
    )`].join(",")};
  background-color: ${t};
  background-size: ${`${n*2}px ${n*2}px`};
  background-position: 0 0, ${`${n}px ${n}px`};
`,_t=()=>T`
  position: relative;
  box-sizing: border-box;
  display: inline-block;
  color: ${({theme:e})=>e.materialText};
  background: ${({$disabled:e,theme:t})=>e?t.flatLight:t.canvas};
  border: 2px solid ${({theme:e})=>e.canvas};
  outline: 2px solid ${({theme:e})=>e.flatDark};
  outline-offset: -4px;
`,xo={button:{topLeftOuter:"borderLightest",topLeftInner:"borderLight",bottomRightInner:"borderDark",bottomRightOuter:"borderDarkest"},buttonPressed:{topLeftOuter:"borderDarkest",topLeftInner:"borderDark",bottomRightInner:"borderLight",bottomRightOuter:"borderLightest"},buttonThin:{topLeftOuter:"borderLightest",topLeftInner:null,bottomRightInner:null,bottomRightOuter:"borderDark"},buttonThinPressed:{topLeftOuter:"borderDark",topLeftInner:null,bottomRightInner:null,bottomRightOuter:"borderLightest"},field:{topLeftOuter:"borderDark",topLeftInner:"borderDarkest",bottomRightInner:"borderLight",bottomRightOuter:"borderLightest"},grouping:{topLeftOuter:"borderDark",topLeftInner:"borderLightest",bottomRightInner:"borderDark",bottomRightOuter:"borderLightest"},status:{topLeftOuter:"borderDark",topLeftInner:null,bottomRightInner:null,bottomRightOuter:"borderLightest"},window:{topLeftOuter:"borderLight",topLeftInner:"borderLightest",bottomRightInner:"borderDark",bottomRightOuter:"borderDarkest"}},Xv=({theme:e,topLeftInner:t,bottomRightInner:n,hasShadow:r=!1,hasInsetShadow:o=!1})=>[r?Nl:!1,o?Il:!1,t!==null?`inset 1px 1px 0px 1px ${e[t]}`:!1,n!==null?`inset -1px -1px 0 1px ${e[n]}`:!1].filter(Boolean).join(", "),X=({invert:e=!1,style:t="button"}={})=>{let n={topLeftOuter:e?"bottomRightOuter":"topLeftOuter",topLeftInner:e?"bottomRightInner":"topLeftInner",bottomRightInner:e?"topLeftInner":"bottomRightInner",bottomRightOuter:e?"topLeftOuter":"bottomRightOuter"};return T`
    border-style: solid;
    border-width: 2px;
    border-left-color: ${({theme:r})=>r[xo[t][n.topLeftOuter]]};
    border-top-color: ${({theme:r})=>r[xo[t][n.topLeftOuter]]};
    border-right-color: ${({theme:r})=>r[xo[t][n.bottomRightOuter]]};
    border-bottom-color: ${({theme:r})=>r[xo[t][n.bottomRightOuter]]};
    box-shadow: ${({theme:r,shadow:o})=>Xv({theme:r,topLeftInner:xo[t][n.topLeftInner],bottomRightInner:xo[t][n.bottomRightInner],hasShadow:o})};
  `},Xt=()=>T`
  outline: 2px dotted ${({theme:e})=>e.materialText};
`,Zv=e=>Buffer.from(e).toString("base64"),qv=typeof btoa<"u"?btoa:Zv,Rs=(e,t=0)=>{let n=`<svg height="26" width="26" viewBox="0 0 26 26" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <g transform="rotate(${t} 13 13)">
      <polygon fill="${e}" points="6,10 20,10 13,17"/>
    </g>
  </svg>`;return`url(data:image/svg+xml;base64,${qv(n)})`},Tr=(e="default")=>T`
  ::-webkit-scrollbar {
    width: 26px;
    height: 26px;
  }
  ::-webkit-scrollbar-track {
    ${({theme:t})=>gn({mainColor:e==="flat"?t.flatLight:t.material,secondaryColor:e==="flat"?t.canvas:t.borderLightest})}
  }
  ::-webkit-scrollbar-thumb {
    ${$e()}
    ${e==="flat"?_t():X({style:"window"})}
      outline-offset: -2px;
  }

  ::-webkit-scrollbar-corner {
    background-color: ${({theme:t})=>t.material};
  }
  ::-webkit-scrollbar-button {
    ${$e()}
    ${e==="flat"?_t():X({style:"window"})}
      display: block;
    outline-offset: -2px;
    height: 26px;
    width: 26px;
    background-repeat: no-repeat;
    background-size: 100%;
    background-position: 0 0;
  }
  ::-webkit-scrollbar-button:active,
  ::-webkit-scrollbar-button:active {
    background-position: 0 1px;
    ${e==="default"?X({style:"window",invert:!0}):""}
  }

  ::-webkit-scrollbar-button:horizontal:increment:start,
  ::-webkit-scrollbar-button:horizontal:decrement:end,
  ::-webkit-scrollbar-button:vertical:increment:start,
  ::-webkit-scrollbar-button:vertical:decrement:end {
    display: none;
  }

  ::-webkit-scrollbar-button:horizontal:decrement {
    background-image: ${({theme:t})=>Rs(t.materialText,90)};
  }

  ::-webkit-scrollbar-button:horizontal:increment {
    background-image: ${({theme:t})=>Rs(t.materialText,270)};
  }

  ::-webkit-scrollbar-button:vertical:decrement {
    background-image: ${({theme:t})=>Rs(t.materialText,180)};
  }

  ::-webkit-scrollbar-button:vertical:increment {
    background-image: ${({theme:t})=>Rs(t.materialText,0)};
  }
`;var _s=D(L(),1);var Jv=y.a`
  color: ${({theme:e})=>e.anchor};
  font-size: inherit;
  text-decoration: ${({underline:e})=>e?"underline":"none"};
  &:visited {
    color: ${({theme:e})=>e.anchorVisited};
  }
`,Dl=(0,_s.forwardRef)(({children:e,underline:t=!0,...n},r)=>_s.default.createElement(Jv,{ref:r,underline:t,...n},e));Dl.displayName="Anchor";var Ns=D(L(),1);var e1=y.header`
  ${X()};
  ${$e()};

  position: ${e=>{var t;return(t=e.position)!==null&&t!==void 0?t:e.fixed?"fixed":"absolute"}};
  top: 0;
  right: 0;
  left: auto;
  display: flex;
  flex-direction: column;
  width: 100%;
`,Wh=(0,Ns.forwardRef)(({children:e,fixed:t=!0,position:n="fixed",...r},o)=>Ns.default.createElement(e1,{fixed:t,position:t!==!1?n:void 0,ref:o,...r},e));Wh.displayName="AppBar";var Pl=D(L(),1);var ct=()=>{};function Zt(e,t,n){return n!==null&&e>n?n:t!==null&&e<t?t:e}function t1(e){if(Math.abs(e)<1){let n=e.toExponential().split("e-"),r=n[0].split(".")[1];return(r?r.length:0)+parseInt(n[1],10)}let t=e.toString().split(".")[1];return t?t.length:0}function jc(e,t,n){let r=Math.round((e-n)/t)*t+n;return Number(r.toFixed(t1(t)))}function dt(e){return typeof e=="number"?`${e}px`:e}var n1=y.div`
  display: inline-block;
  box-sizing: border-box;
  object-fit: contain;
  ${({size:e})=>`
    height: ${e};
    width: ${e};
    `}
  border-radius: ${({square:e})=>e?0:"50%"};
  overflow: hidden;
  ${({noBorder:e,theme:t})=>!e&&`
    border-top: 2px solid ${t.borderDark};
    border-left: 2px solid ${t.borderDark};
    border-bottom: 2px solid ${t.borderLightest};
    border-right: 2px solid ${t.borderLightest};
    background: ${t.material};
  `}
  ${({src:e})=>!e&&`
    display: flex;
    align-items: center;
    justify-content: space-around;
    font-weight: bold;
    font-size: 1rem;
  `}
`,r1=y.img`
  display: block;
  object-fit: contain;
  width: 100%;
  height: 100%;
`,Uh=(0,Pl.forwardRef)(({alt:e="",children:t,noBorder:n=!1,size:r=35,square:o=!1,src:l,...i},s)=>Pl.default.createElement(n1,{noBorder:n,ref:s,size:dt(r),square:o,src:l,...i},l?Pl.default.createElement(r1,{src:l,alt:e}):t));Uh.displayName="Avatar";var Is=D(L(),1);var ie={sm:"28px",md:"36px",lg:"44px"};var o1=T`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: ${({size:e="md"})=>ie[e]};
  width: ${({fullWidth:e,size:t="md",square:n})=>e?"100%":n?ie[t]:"auto"};
  padding: ${({square:e})=>e?0:"0 10px"};
  font-size: 1rem;
  user-select: none;
  &:active {
    padding-top: ${({disabled:e})=>!e&&"2px"};
  }
  padding-top: ${({active:e,disabled:t})=>e&&!t&&"2px"};
  &:after {
    content: '';
    position: absolute;
    display: block;
    top: 0;
    left: 0;
    height: 100%;
    width: 100%;
  }
  &:not(:disabled) {
    cursor: pointer;
  }
  font-family: inherit;
`,Kn=y.button`
  ${({active:e,disabled:t,primary:n,theme:r,variant:o})=>o==="flat"?T`
          ${_t()}
          ${n?`
          border: 2px solid ${r.checkmark};
            outline: 2px solid ${r.flatDark};
            outline-offset: -4px;
          `:`
          border: 2px solid ${r.flatDark};
            outline: 2px solid transparent;
            outline-offset: -4px;
          `}
          &:focus:after, &:active:after {
            ${!e&&!t&&Xt}
            outline-offset: -4px;
          }
        `:o==="menu"||o==="thin"?T`
          ${$e()};
          border: 2px solid transparent;
          &:hover,
          &:focus {
            ${!t&&!e&&X({style:"buttonThin"})}
          }
          &:active {
            ${!t&&X({style:"buttonThinPressed"})}
          }
          ${e&&X({style:"buttonThinPressed"})}
          ${t&&Re()}
        `:T`
          ${$e()};
          border: none;
          ${t&&Re()}
          ${e?gn({mainColor:r.material,secondaryColor:r.borderLightest}):""}
          &:before {
            box-sizing: border-box;
            content: '';
            position: absolute;
            ${n?T`
                  left: 2px;
                  top: 2px;
                  width: calc(100% - 4px);
                  height: calc(100% - 4px);
                  outline: 2px solid ${r.borderDarkest};
                `:T`
                  left: 0;
                  top: 0;
                  width: 100%;
                  height: 100%;
                `}

            ${e?X({style:o==="raised"?"window":"button",invert:!0}):X({style:o==="raised"?"window":"button",invert:!1})}
          }
          &:active:before {
            ${!t&&X({style:o==="raised"?"window":"button",invert:!0})}
          }
          &:focus:after,
          &:active:after {
            ${!e&&!t&&Xt}
            outline-offset: -8px;
          }
          &:active:focus:after,
          &:active:after {
            top: ${e?"0":"1px"};
          }
        `}
  ${o1}
`,ue=(0,Is.forwardRef)(({onClick:e,disabled:t=!1,children:n,type:r="button",fullWidth:o=!1,size:l="md",square:i=!1,active:s=!1,onTouchStart:a=ct,primary:c=!1,variant:h="default",...p},g)=>Is.default.createElement(Kn,{active:s,disabled:t,$disabled:t,fullWidth:o,onClick:t?void 0:e,onTouchStart:a,primary:c,ref:g,size:l,square:i,type:r,variant:h,...p},n));ue.displayName="Button";var qt=D(L(),1);var Ds=D(L(),1);function tt({defaultValue:e,onChange:t,onChangePropName:n="onChange",readOnly:r,value:o,valuePropName:l="value"}){let i=o!==void 0,[s,a]=(0,Ds.useState)(e),c=(0,Ds.useCallback)(h=>{i||a(h)},[i]);if(i&&typeof t!="function"&&!r){let h=`Warning: You provided a \`${l}\` prop to a component without an \`${n}\` handler.${l==="value"?`This will render a read-only field. If the field should be mutable use \`defaultValue\`. Otherwise, set either \`${n}\` or \`readOnly\`.`:`This breaks the component state. You must provide an \`${n}\` function that updates \`${l}\`.`}`;console.warn(h)}return[i?o:s,c]}var Ps=D(L(),1);var $r=y.li`
  box-sizing: border-box;

  display: flex;
  align-items: center;
  position: relative;
  height: ${e=>ie[e.size]};
  width: ${e=>e.square?ie[e.size]:"auto"};
  padding: 0 8px;
  font-size: 1rem;
  white-space: nowrap;
  justify-content: ${e=>e.square?"space-around":"space-between"};
  text-align: center;
  line-height: ${e=>ie[e.size]};
  color: ${({theme:e})=>e.materialText};
  pointer-events: ${({$disabled:e})=>e?"none":"auto"};
  font-weight: ${({primary:e})=>e?"bold":"normal"};
  &:hover {
    ${({theme:e,$disabled:t})=>!t&&`
        color: ${e.materialTextInvert};
        background: ${e.hoverBackground};
      `}

    cursor: default;
  }
  ${e=>e.$disabled&&Re()}
`,ft=(0,Ps.forwardRef)(({size:e="lg",disabled:t,square:n,children:r,onClick:o,primary:l,...i},s)=>Ps.default.createElement($r,{$disabled:t,size:e,square:n,onClick:t?void 0:o,primary:l,role:"menuitem",ref:s,"aria-disabled":t,...i},r));ft.displayName="MenuListItem";var wo=y.ul.attrs(()=>({role:"menu"}))`
  box-sizing: border-box;
  width: ${e=>e.fullWidth?"100%":"auto"};
  padding: 4px;
  ${X({style:"window"})}
  ${$e()}
  ${e=>e.inline&&`
    display: inline-flex;
    align-items: center;
  `}
  list-style: none;
  position: relative;
`;wo.displayName="MenuList";var Nt=20,ko=y.input`
  position: absolute;
  left: 0;
  margin: 0;
  width: ${Nt}px;
  height: ${Nt}px;
  opacity: 0;
  z-index: -1;
`,So=y.label`
  display: inline-flex;
  align-items: center;
  position: relative;
  margin: 8px 0;
  cursor: ${({$disabled:e})=>e?"auto":"pointer"};
  user-select: none;
  font-size: 1rem;
  color: ${({theme:e})=>e.materialText};
  ${e=>e.$disabled&&Re()}

  ${$r} & {
    margin: 0;
    height: 100%;
  }
  ${$r}:hover & {
    ${({$disabled:e,theme:t})=>!e&&T`
        color: ${t.materialTextInvert};
      `};
  }
`,bo=y.span`
  display: inline-block;
  line-height: 1;
  padding: 2px;
  ${ko}:focus ~ & {
    ${Xt}
  }
  ${ko}:not(:disabled) ~ &:active {
    ${Xt}
  }
`;var Ll=D(L(),1);var _e=y.div`
  position: relative;
  box-sizing: border-box;
  padding: 2px;
  font-size: 1rem;
  border-style: solid;
  border-width: 2px;
  border-left-color: ${({theme:e})=>e.borderDark};
  border-top-color: ${({theme:e})=>e.borderDark};
  border-right-color: ${({theme:e})=>e.borderLightest};
  border-bottom-color: ${({theme:e})=>e.borderLightest};
  line-height: 1.5;
  &:before {
    position: absolute;
    left: 0;
    top: 0;
    content: '';
    width: calc(100% - 4px);
    height: calc(100% - 4px);

    border-style: solid;
    border-width: 2px;
    border-left-color: ${({theme:e})=>e.borderDarkest};
    border-top-color: ${({theme:e})=>e.borderDarkest};
    border-right-color: ${({theme:e})=>e.borderLight};
    border-bottom-color: ${({theme:e})=>e.borderLight};

    pointer-events: none;
    ${e=>e.shadow&&`box-shadow:${Il};`}
  }
`,l1=y.div`
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 4px;
  overflow: auto;
  ${Tr()}
`,zl=(0,Ll.forwardRef)(({children:e,shadow:t=!0,...n},r)=>Ll.default.createElement(_e,{ref:r,shadow:t,...n},Ll.default.createElement(l1,null,e)));zl.displayName="ScrollView";var Qh=T`
  width: ${Nt}px;
  height: ${Nt}px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  margin-right: 0.5rem;
`,i1=y(_e)`
  ${Qh}
  width: ${Nt}px;
  height: ${Nt}px;
  background: ${({$disabled:e,theme:t})=>e?t.material:t.canvas};
  &:before {
    box-shadow: none;
  }
`,s1=y.div`
  position: relative;
  box-sizing: border-box;
  display: inline-block;
  background: ${({$disabled:e,theme:t})=>e?t.flatLight:t.canvas};
  ${Qh}
  width: ${Nt-4}px;
  height: ${Nt-4}px;
  outline: none;
  border: 2px solid ${({theme:e})=>e.flatDark};
  background: ${({$disabled:e,theme:t})=>e?t.flatLight:t.canvas};
`,a1=y.span.attrs(()=>({"data-testid":"checkmarkIcon"}))`
  display: inline-block;
  position: relative;
  width: 100%;
  height: 100%;
  &:after {
    content: '';
    display: block;
    position: absolute;
    left: 50%;
    top: calc(50% - 1px);
    width: 3px;
    height: 7px;

    border: solid
      ${({$disabled:e,theme:t})=>e?t.checkmarkDisabled:t.checkmark};
    border-width: 0 3px 3px 0;
    transform: translate(-50%, -50%) rotate(45deg);

    border-color: ${e=>e.$disabled?e.theme.checkmarkDisabled:e.theme.checkmark};
  }
`,u1=y.span.attrs(()=>({"data-testid":"indeterminateIcon"}))`
  display: inline-block;
  position: relative;

  width: 100%;
  height: 100%;

  &:after {
    content: '';
    display: block;

    width: 100%;
    height: 100%;

    ${({$disabled:e,theme:t})=>gn({mainColor:e?t.checkmarkDisabled:t.checkmark})}
    background-position: 0px 0px, 2px 2px;
  }
`,c1={flat:s1,default:i1},Yn=(0,qt.forwardRef)(({checked:e,className:t="",defaultChecked:n=!1,disabled:r=!1,indeterminate:o=!1,label:l="",onChange:i=ct,style:s={},value:a,variant:c="default",...h},p)=>{var g;let[w,v]=tt({defaultValue:n,onChange:i,readOnly:(g=h.readOnly)!==null&&g!==void 0?g:r,value:e}),k=(0,qt.useCallback)(u=>{let f=u.target.checked;v(f),i(u)},[i,v]),R=c1[c],d=null;return o?d=u1:w&&(d=a1),qt.default.createElement(So,{$disabled:r,className:t,style:s},qt.default.createElement(ko,{disabled:r,onChange:r?void 0:k,readOnly:r,type:"checkbox",value:a,checked:w,"data-indeterminate":o,ref:p,...h}),qt.default.createElement(R,{$disabled:r,role:"presentation"},d&&qt.default.createElement(d,{$disabled:r,variant:c})),l&&qt.default.createElement(bo,null,l))});Yn.displayName="Checkbox";var Xn=D(L(),1);var nt=y.div`
  ${({orientation:e,theme:t,size:n="100%"})=>e==="vertical"?`
    height: ${dt(n)};
    border-left: 2px solid ${t.borderDark};
    border-right: 2px solid ${t.borderLightest};
    margin: 0;
    `:`
    width: ${dt(n)};
    border-bottom: 2px solid ${t.borderLightest};
    border-top: 2px solid ${t.borderDark};
    margin: 0;
    `}
`;nt.displayName="Separator";var d1=y(Kn)`
  padding-left: 8px;
`,f1=y(nt)`
  height: 21px;
  position: relative;
  top: 0;
`,Vc=y.input`
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  position: absolute;
  left: 0;
  top: 0;
  opacity: 0;
  z-index: 1;
  cursor: pointer;
  &:disabled {
    cursor: default;
  }
`,p1=y.div`
  box-sizing: border-box;
  height: 19px;
  display: inline-block;
  width: 35px;
  margin-right: 5px;

  background: ${({color:e})=>e};

  ${({$disabled:e})=>e?T`
          border: 2px solid ${({theme:t})=>t.materialTextDisabled};
          filter: drop-shadow(
            1px 1px 0px ${({theme:t})=>t.materialTextDisabledShadow}
          );
        `:T`
          border: 2px solid ${({theme:t})=>t.materialText};
        `}
  ${Vc}:focus:not(:active) + &:after {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    ${Xt}
    outline-offset: -8px;
  }
`,m1=y.span`
  width: 0px;
  height: 0px;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  display: inline-block;
  margin-left: 6px;

  ${({$disabled:e})=>e?T`
          border-top: 6px solid ${({theme:t})=>t.materialTextDisabled};
          filter: drop-shadow(
            1px 1px 0px ${({theme:t})=>t.materialTextDisabledShadow}
          );
        `:T`
          border-top: 6px solid ${({theme:t})=>t.materialText};
        `}
  &:after {
    content: '';
    box-sizing: border-box;
    position: absolute;
    top: ${({variant:e})=>e==="flat"?"6px":"8px"};
    right: 8px;
    width: 16px;
    height: 19px;
  }
`,Gh=(0,Xn.forwardRef)(({value:e,defaultValue:t,onChange:n=ct,disabled:r=!1,variant:o="default",...l},i)=>{var s;let[a,c]=tt({defaultValue:t,onChange:n,readOnly:(s=l.readOnly)!==null&&s!==void 0?s:r,value:e}),h=p=>{let g=p.target.value;c(g),n(p)};return Xn.default.createElement(d1,{disabled:r,as:"div",variant:o,size:"md"},Xn.default.createElement(Vc,{onChange:h,readOnly:r,disabled:r,value:a??"#008080",type:"color",ref:i,...l}),Xn.default.createElement(p1,{$disabled:r,color:a??"#008080",role:"presentation"}),o==="default"&&Xn.default.createElement(f1,{orientation:"vertical"}),Xn.default.createElement(m1,{$disabled:r,variant:o}))});Gh.displayName="ColorInput";var Rr=D(L(),1);var Hc=D(L(),1);var h1=y.div`
  position: relative;
  --react95-digit-primary-color: #ff0102;
  --react95-digit-secondary-color: #740201;
  --react95-digit-bg-color: #000000;

  ${({pixelSize:e})=>T`
    width: ${11*e}px;
    height: ${21*e}px;
    margin: ${e}px;

    span,
    span:before,
    span:after {
      box-sizing: border-box;
      display: inline-block;
      position: absolute;
    }
    span.active,
    span.active:before,
    span.active:after {
      background: var(--react95-digit-primary-color);
    }
    span:not(.active),
    span:not(.active):before,
    span:not(.active):after {
      ${gn({mainColor:"var(--react95-digit-bg-color)",secondaryColor:"var(--react95-digit-secondary-color)",pixelSize:e})}
    }

    span.horizontal,
    span.horizontal:before,
    span.horizontal:after {
      height: ${e}px;
      border-left: ${e}px solid var(--react95-digit-bg-color);
      border-right: ${e}px solid var(--react95-digit-bg-color);
    }
    span.horizontal.active,
    span.horizontal.active:before,
    span.horizontal.active:after {
      height: ${e}px;
      border-left: ${e}px solid var(--react95-digit-primary-color);
      border-right: ${e}px solid var(--react95-digit-primary-color);
    }
    span.horizontal {
      left: ${e}px;
      width: ${9*e}px;
    }
    span.horizontal:before {
      content: '';
      width: 100%;
      top: ${e}px;
      left: ${0}px;
    }
    span.horizontal:after {
      content: '';
      width: calc(100% - ${e*2}px);
      top: ${2*e}px;
      left: ${e}px;
    }
    span.horizontal.top {
      top: 0;
    }
    span.horizontal.bottom {
      bottom: 0;
      transform: rotateX(180deg);
    }

    span.center,
    span.center:before,
    span.center:after {
      height: ${e}px;
      border-left: ${e}px solid var(--react95-digit-bg-color);
      border-right: ${e}px solid var(--react95-digit-bg-color);
    }
    span.center.active,
    span.center.active:before,
    span.center.active:after {
      border-left: ${e}px solid var(--react95-digit-primary-color);
      border-right: ${e}px solid var(--react95-digit-primary-color);
    }
    span.center {
      top: 50%;
      transform: translateY(-50%);
      left: ${e}px;
      width: ${9*e}px;
    }
    span.center:before,
    span.center:after {
      content: '';
      width: 100%;
    }
    span.center:before {
      top: ${e}px;
    }
    span.center:after {
      bottom: ${e}px;
    }

    span.vertical,
    span.vertical:before,
    span.vertical:after {
      width: ${e}px;
      border-top: ${e}px solid var(--react95-digit-bg-color);
      border-bottom: ${e}px solid var(--react95-digit-bg-color);
    }
    span.vertical {
      height: ${11*e}px;
    }
    span.vertical.left {
      left: 0;
    }
    span.vertical.right {
      right: 0;
      transform: rotateY(180deg);
    }
    span.vertical.top {
      top: 0px;
    }
    span.vertical.bottom {
      bottom: 0px;
    }
    span.vertical:before {
      content: '';
      height: 100%;
      top: ${0}px;
      left: ${e}px;
    }
    span.vertical:after {
      content: '';
      height: calc(100% - ${e*2}px);
      top: ${e}px;
      left: ${e*2}px;
    }
  `}
`,Kh=["horizontal top","center","horizontal bottom","vertical top left","vertical top right","vertical bottom left","vertical bottom right"],g1=[[1,0,1,1,1,1,1],[0,0,0,0,1,0,1],[1,1,1,0,1,1,0],[1,1,1,0,1,0,1],[0,1,0,1,1,0,1],[1,1,1,1,0,0,1],[1,1,1,1,0,1,1],[1,0,0,0,1,0,1],[1,1,1,1,1,1,1],[1,1,1,1,1,0,1]];function Yh({digit:e=0,pixelSize:t=2,...n}){let r=g1[Number(e)].map((o,l)=>o?`${Kh[l]} active`:Kh[l]);return Hc.default.createElement(h1,{pixelSize:t,...n},r.map((o,l)=>Hc.default.createElement("span",{className:o,key:l})))}var y1=y.div`
  ${X({style:"status"})}
  display: inline-flex;
  background: #000000;
`,v1={sm:1,md:2,lg:3,xl:4},Xh=(0,Rr.forwardRef)(({value:e=0,minLength:t=3,size:n="md",...r},o)=>{let l=(0,Rr.useMemo)(()=>e.toString().padStart(t,"0").split(""),[t,e]);return Rr.default.createElement(y1,{ref:o,...r},l.map((i,s)=>Rr.default.createElement(Yh,{digit:i,pixelSize:v1[n],key:s})))});Xh.displayName="Counter";var W=D(L(),1);var Xe=D(L(),1);var Zn=D(L(),1);var Zh=T`
  display: flex;
  align-items: center;
  width: ${({fullWidth:e})=>e?"100%":"auto"};
  min-height: ${ie.md};
`,x1=y(_e).attrs({"data-testid":"variant-default"})`
  ${Zh}
  background: ${({$disabled:e,theme:t})=>e?t.material:t.canvas};
`,w1=y.div.attrs({"data-testid":"variant-flat"})`
  ${_t()}
  ${Zh}
  position: relative;
`,qh=T`
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  outline: none;
  border: none;
  background: none;
  font-size: 1rem;
  min-height: 27px;
  font-family: inherit;
  color: ${({theme:e})=>e.canvasText};
  ${({disabled:e,variant:t})=>t!=="flat"&&e&&Re()}
`,k1=y.input`
  ${qh}
  padding: 0 8px;
`,S1=y.textarea`
  ${qh}
  padding: 8px;
  resize: none;
  ${({variant:e})=>Tr(e)}
`,Vt=(0,Zn.forwardRef)(({className:e,disabled:t=!1,fullWidth:n,onChange:r=ct,shadow:o=!0,style:l,variant:i="default",...s},a)=>{let c=i==="flat"?w1:x1,h=(0,Zn.useMemo)(()=>{var p;return s.multiline?Zn.default.createElement(S1,{disabled:t,onChange:t?void 0:r,readOnly:t,ref:a,variant:i,...s}):Zn.default.createElement(k1,{disabled:t,onChange:t?void 0:r,readOnly:t,ref:a,type:(p=s.type)!==null&&p!==void 0?p:"text",variant:i,...s})},[t,r,s,a,i]);return Zn.default.createElement(c,{className:e,fullWidth:n,$disabled:t,shadow:o,style:l},h)});Vt.displayName="TextInput";var b1=y.div`
  display: inline-flex;
  align-items: center;
`,Wc=y(ue)`
  width: 30px;
  padding: 0;
  flex-shrink: 0;

  ${({variant:e})=>e==="flat"?T`
          height: calc(50% - 1px);
        `:T`
          height: 50%;
        `}
`,E1=y.div`
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  justify-content: space-between;

  ${({variant:e})=>e==="flat"?T`
          height: calc(${ie.md} - 4px);
        `:T`
          height: ${ie.md};
          margin-left: 2px;
        `}
`,Jh=y.span`
  width: 0px;
  height: 0px;
  display: inline-block;
  ${({invert:e})=>e?T`
          border-left: 4px solid transparent;
          border-right: 4px solid transparent;
          border-bottom: 4px solid ${({theme:t})=>t.materialText};
        `:T`
          border-left: 4px solid transparent;
          border-right: 4px solid transparent;
          border-top: 4px solid ${({theme:t})=>t.materialText};
        `}
  ${Wc}:disabled & {
    filter: drop-shadow(
      1px 1px 0px ${({theme:e})=>e.materialTextDisabledShadow}
    );
    ${({invert:e})=>e?T`
            border-bottom-color: ${({theme:t})=>t.materialTextDisabled};
          `:T`
            border-top-color: ${({theme:t})=>t.materialTextDisabled};
          `}
  }
`,Ol=(0,Xe.forwardRef)(({className:e,defaultValue:t,disabled:n=!1,max:r,min:o,onChange:l,readOnly:i,step:s=1,style:a,value:c,variant:h="default",width:p,...g},w)=>{let[v,k]=tt({defaultValue:t,onChange:l,readOnly:i,value:c}),R=(0,Xe.useCallback)(E=>{let b=parseFloat(E.target.value);k(b)},[k]),d=(0,Xe.useCallback)(E=>{let b=Zt(parseFloat(((v??0)+E).toFixed(2)),o??null,r??null);k(b),l?.(b)},[r,o,l,k,v]),u=(0,Xe.useCallback)(()=>{v!==void 0&&l?.(v)},[l,v]),f=(0,Xe.useCallback)(()=>{d(s)},[d,s]),x=(0,Xe.useCallback)(()=>{d(-s)},[d,s]),S=h==="flat"?"flat":"raised";return Xe.default.createElement(b1,{className:e,style:{...a,width:p!==void 0?dt(p):"auto"},...g},Xe.default.createElement(Vt,{value:v,variant:h,onChange:R,disabled:n,type:"number",readOnly:i,ref:w,fullWidth:!0,onBlur:u}),Xe.default.createElement(E1,{variant:h},Xe.default.createElement(Wc,{"data-testid":"increment",variant:S,disabled:n||i,onClick:f},Xe.default.createElement(Jh,{invert:!0})),Xe.default.createElement(Wc,{"data-testid":"decrement",variant:S,disabled:n||i,onClick:x},Xe.default.createElement(Jh,null))))});Ol.displayName="NumberInput";var ge=D(L(),1);var e0=D(L(),1);function A1(){let e="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",t="";for(let n=0;n<10;n+=1)t+=e[Math.floor(Math.random()*e.length)];return t}var Uc=e=>(0,e0.useMemo)(()=>e??A1(),[e]);var t0=T`
  box-sizing: border-box;
  padding-left: 4px;
  overflow: hidden;
  white-space: nowrap;
  user-select: none;
  line-height: 100%;
`,n0=T`
  background: ${({theme:e})=>e.hoverBackground};
  color: ${({theme:e})=>e.canvasTextInvert};
`,Bl=y.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  width: 100%;
  &:focus {
    outline: none;
  }
`,r0=y.div`
  ${t0}
  padding-right: 8px;
  align-items: center;
  display: flex;
  height: calc(100% - 4px);
  width: calc(100% - 4px);
  margin: 0 2px;
  border: 2px solid transparent;
  ${Bl}:focus & {
    ${n0}
    border: 2px dotted ${({theme:e})=>e.focusSecondary};
  }
`,o0=T`
  height: ${ie.md};
  display: inline-block;
  color: ${({$disabled:e=!1,theme:t})=>e?Re():t.canvasText};
  font-size: 1rem;
  cursor: ${({$disabled:e})=>e?"default":"pointer"};
`,l0=y(_e)`
  ${o0}
  background: ${({$disabled:e=!1,theme:t})=>e?t.material:t.canvas};
  &:focus {
    outline: 0;
  }
`,i0=y.div`
  ${_t()}
  ${o0}
  background: ${({$disabled:e=!1,theme:t})=>e?t.flatLight:t.canvas};
`,s0=y.select`
  -moz-appearance: none;
  -webkit-appearance: none;
  display: block;
  width: 100%;
  height: 100%;
  color: inherit;
  font-size: 1rem;
  border: 0;
  margin: 0;
  background: none;
  -webkit-tap-highlight-color: transparent;
  border-radius: 0;
  padding-right: 30px;
  ${t0}
  cursor: pointer;
  &:disabled {
    ${Re()};
    background: ${({theme:e})=>e.material};
    cursor: default;
  }
`,Qc=y(Kn).attrs(()=>({"aria-hidden":"true"}))`
  width: 30px;
  padding: 0;
  flex-shrink: 0;
  ${({variant:e="default"})=>e==="flat"?T`
          height: 100%;
          margin-right: 0;
        `:T`
          height: 100%;
        `}
  ${({native:e=!1,variant:t="default"})=>e&&(t==="flat"?`
      position: absolute;
      right: 0;
      height: 100%;
      `:`
    position: absolute;
    top: 2px;
    right: 2px;
    height: calc(100% - 4px);
    `)}
    pointer-events: ${({$disabled:e=!1,native:t=!1})=>e||t?"none":"auto"}
`,a0=y.span`
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  display: inline-block;
  border-top: 6px solid
    ${({$disabled:e=!1,theme:t})=>e?t.materialTextDisabled:t.materialText};
  ${({$disabled:e=!1,theme:t})=>e&&`
    filter: drop-shadow(1px 1px 0px ${t.materialTextDisabledShadow});
    border-top-color: ${t.materialTextDisabled};
    `}
  ${Qc}:active & {
    margin-top: 2px;
  }
`,u0=y.ul`
  box-sizing: border-box;

  font-size: 1rem;
  position: absolute;
  transform: translateY(100%);
  left: 0;
  background: ${({theme:e})=>e.canvas};
  padding: 2px;
  border-top: none;
  cursor: default;
  z-index: 1;
  cursor: pointer;
  box-shadow: ${Nl};
  ${({variant:e="default"})=>e==="flat"?T`
          bottom: 2px;
          width: 100%;
          border: 2px solid ${({theme:t})=>t.flatDark};
        `:T`
          bottom: -2px;
          width: calc(100% - 2px);
          border: 2px solid ${({theme:t})=>t.borderDarkest};
        `}
  ${({variant:e="default"})=>Tr(e)}
`,c0=y.li`
  box-sizing: border-box;

  width: 100%;
  padding-left: 8px;

  height: calc(${ie.md} - 4px);
  line-height: calc(${ie.md} - 4px);
  font-size: 1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: ${({theme:e})=>e.canvasText};
  &:focus {
    outline: 0;
  }
  ${({active:e})=>e?n0:""}
  user-select: none;
`;var yn=D(L(),1);var C1=[],Ls=({className:e,defaultValue:t,disabled:n,native:r,onChange:o,options:l=C1,readOnly:i,style:s,value:a,variant:c,width:h})=>{var p;let g=(0,yn.useMemo)(()=>l.filter(Boolean),[l]),[w,v]=tt({defaultValue:t??((p=g?.[0])===null||p===void 0?void 0:p.value),onChange:o,readOnly:i,value:a}),k=!(n||i),R=(0,yn.useMemo)(()=>({className:e,style:{...s,width:h}}),[e,s,h]),d=(0,yn.useMemo)(()=>yn.default.createElement(Qc,{as:"div","data-testid":"select-button",$disabled:n,native:r,tabIndex:-1,variant:c==="flat"?"flat":"raised"},yn.default.createElement(a0,{"data-testid":"select-icon",$disabled:n})),[n,r,c]),u=(0,yn.useMemo)(()=>c==="flat"?i0:l0,[c]);return(0,yn.useMemo)(()=>({isEnabled:k,options:g,value:w,setValue:v,wrapperProps:R,DropdownButton:d,Wrapper:u}),[d,u,k,g,v,w,R])};var H=D(L(),1);var d0={ARROW_DOWN:"ArrowDown",ARROW_LEFT:"ArrowLeft",ARROW_RIGHT:"ArrowRight",ARROW_UP:"ArrowUp",END:"End",ENTER:"Enter",ESC:"Escape",HOME:"Home",SPACE:"Space",TAB:"Tab"};var T1=1e3,f0=({onBlur:e,onChange:t,onClose:n,onFocus:r,onKeyDown:o,onMouseDown:l,onOpen:i,open:s,options:a,readOnly:c,value:h,selectRef:p,setValue:g,wrapperRef:w})=>{let v=(0,H.useRef)(null),k=(0,H.useRef)([]),R=(0,H.useRef)(0),d=(0,H.useRef)(0),u=(0,H.useRef)(),f=(0,H.useRef)("search"),x=(0,H.useRef)(""),S=(0,H.useRef)(),[E,b]=tt({defaultValue:!1,onChange:i,onChangePropName:"onOpen",readOnly:c,value:s,valuePropName:"open"}),A=(0,H.useMemo)(()=>{let $=a.findIndex(P=>P.value===h);return R.current=Zt($,0,null),a[$]},[a,h]),[B,I]=(0,H.useState)(a[0]),U=(0,H.useCallback)($=>{let P=v.current,Y=k.current[$];if(!Y||!P){u.current=$;return}u.current=void 0;let de=P.clientHeight,se=P.scrollTop,Be=P.scrollTop+de,Ae=Y.offsetTop,wt=Y.offsetHeight,tn=Y.offsetTop+Y.offsetHeight;Ae<se&&P.scrollTo(0,Ae),tn>Be&&P.scrollTo(0,Ae-de+wt),Y.focus({preventScroll:!0})},[v]),Z=(0,H.useCallback)(($,{scroll:P}={})=>{var Y;let de=a.length-1,se;switch($){case"first":{se=0;break}case"last":{se=de;break}case"next":{se=Zt(d.current+1,0,de);break}case"previous":{se=Zt(d.current-1,0,de);break}case"selected":{se=Zt((Y=R.current)!==null&&Y!==void 0?Y:0,0,de);break}default:se=$}d.current=se,I(a[se]),P&&U(se)},[d,a,U]),q=(0,H.useCallback)(({fromEvent:$})=>{b(!0),Z("selected",{scroll:!0}),i?.({fromEvent:$})},[Z,i,b]),ce=(0,H.useCallback)(()=>{f.current="search",x.current="",clearTimeout(S.current)},[]),xe=(0,H.useCallback)(({focusSelect:$,fromEvent:P})=>{var Y;n?.({fromEvent:P}),b(!1),I(a[0]),ce(),u.current=void 0,$&&((Y=p.current)===null||Y===void 0||Y.focus())},[ce,n,a,p,b]),Ve=(0,H.useCallback)(({fromEvent:$})=>{E?xe({focusSelect:!1,fromEvent:$}):q({fromEvent:$})},[xe,q,E]),He=(0,H.useCallback)(($,{fromEvent:P})=>{R.current!==$&&(R.current=$,g(a[$].value),t?.(a[$],{fromEvent:P}))},[t,a,g]),j=(0,H.useCallback)(({focusSelect:$,fromEvent:P})=>{He(d.current,{fromEvent:P}),xe({focusSelect:$,fromEvent:P})},[xe,He]),ye=(0,H.useCallback)(($,{fromEvent:P,select:Y})=>{var de;switch(f.current==="cycleFirstLetter"&&$!==x.current&&(f.current="search"),$===x.current?f.current="cycleFirstLetter":x.current+=$,f.current){case"search":{let se=a.findIndex(Be=>{var Ae;return((Ae=Be.label)===null||Ae===void 0?void 0:Ae.toLocaleUpperCase().indexOf(x.current))===0});se<0&&(se=a.findIndex(Be=>{var Ae;return((Ae=Be.label)===null||Ae===void 0?void 0:Ae.toLocaleUpperCase().indexOf($))===0}),x.current=$),se>=0&&(Y?He(se,{fromEvent:P}):Z(se,{scroll:!0}));break}case"cycleFirstLetter":{let se=Y?(de=R.current)!==null&&de!==void 0?de:-1:d.current,Be=a.findIndex((Ae,wt)=>{var tn;return wt>se&&((tn=Ae.label)===null||tn===void 0?void 0:tn.toLocaleUpperCase().indexOf($))===0});Be<0&&(Be=a.findIndex(Ae=>{var wt;return((wt=Ae.label)===null||wt===void 0?void 0:wt.toLocaleUpperCase().indexOf($))===0})),Be>=0&&(Y?He(Be,{fromEvent:P}):Z(Be,{scroll:!0}));break}}clearTimeout(S.current),S.current=setTimeout(()=>{f.current==="search"&&(x.current="")},T1)},[Z,a,He]),Oe=(0,H.useCallback)($=>{var P;$.button===0&&($.preventDefault(),(P=p.current)===null||P===void 0||P.focus(),Ve({fromEvent:$}),l?.($))},[l,p,Ve]),De=(0,H.useCallback)($=>{j({focusSelect:!0,fromEvent:$})},[j]),Ee=(0,H.useCallback)($=>{let{altKey:P,code:Y,ctrlKey:de,metaKey:se,shiftKey:Be}=$,{ARROW_DOWN:Ae,ARROW_UP:wt,END:tn,ENTER:ir,ESC:bn,HOME:Js,SPACE:ea,TAB:$o}=d0,id=P||de||se||Be;if(!(Y===$o&&(P||de||se)||Y!==$o&&id))switch(Y){case Ae:{if($.preventDefault(),!E){q({fromEvent:$});return}Z("next",{scroll:!0});break}case wt:{if($.preventDefault(),!E){q({fromEvent:$});return}Z("previous",{scroll:!0});break}case tn:{if($.preventDefault(),!E){q({fromEvent:$});return}Z("last",{scroll:!0});break}case ir:{if(!E)return;$.preventDefault(),j({focusSelect:!0,fromEvent:$});break}case bn:{if(!E)return;$.preventDefault(),xe({focusSelect:!0,fromEvent:$});break}case Js:{if($.preventDefault(),!E){q({fromEvent:$});return}Z("first",{scroll:!0});break}case ea:{$.preventDefault(),E?j({focusSelect:!0,fromEvent:$}):q({fromEvent:$});break}case $o:{if(!E)return;Be||$.preventDefault(),j({focusSelect:!Be,fromEvent:$});break}default:!id&&Y.match(/^Key/)&&($.preventDefault(),$.stopPropagation(),ye(Y.replace(/^Key/,""),{select:!E,fromEvent:$}))}},[Z,xe,E,q,ye,j]),O=(0,H.useCallback)($=>{Ee($),o?.($)},[Ee,o]),N=(0,H.useCallback)($=>{Z($)},[Z]),K=(0,H.useCallback)($=>{E||(ce(),e?.($))},[ce,e,E]),V=(0,H.useCallback)($=>{ce(),r?.($)},[ce,r]),M=(0,H.useCallback)($=>{v.current=$,u.current!==void 0&&U(u.current)},[U]),J=(0,H.useCallback)(($,P)=>{k.current[P]=$,u.current===P&&U(u.current)},[U]);return(0,H.useEffect)(()=>{if(!E)return()=>{};let $=P=>{var Y;let de=P.target;!((Y=w.current)===null||Y===void 0)&&Y.contains(de)||(P.preventDefault(),xe({focusSelect:!1,fromEvent:P}))};return document.addEventListener("mousedown",$),()=>{document.removeEventListener("mousedown",$)}},[xe,E,w]),(0,H.useMemo)(()=>({activeOption:B,handleActivateOptionIndex:N,handleBlur:K,handleButtonKeyDown:O,handleDropdownKeyDown:Ee,handleFocus:V,handleMouseDown:Oe,handleOptionClick:De,handleSetDropdownRef:M,handleSetOptionRef:J,open:E,selectedOption:A}),[B,N,K,O,V,Ee,Oe,De,M,J,E,A])};var vn=D(L(),1);var Gc=(0,vn.forwardRef)(({className:e,defaultValue:t,disabled:n,onChange:r,options:o,readOnly:l,style:i,value:s,variant:a,width:c,...h},p)=>{let{isEnabled:g,options:w,setValue:v,value:k,DropdownButton:R,Wrapper:d}=Ls({defaultValue:t,disabled:n,native:!0,onChange:r,options:o,readOnly:l,value:s,variant:a}),u=(0,vn.useCallback)(f=>{let x=w.find(S=>S.value===f.target.value);x&&(v(x.value),r?.(x,{fromEvent:f}))},[r,w,v]);return vn.default.createElement(d,{className:e,style:{...i,width:c}},vn.default.createElement(Bl,null,vn.default.createElement(s0,{...h,disabled:n,onChange:g?u:ct,ref:p,value:k},w.map((f,x)=>{var S;return vn.default.createElement("option",{key:`${f.value}-${x}`,value:f.value},(S=f.label)!==null&&S!==void 0?S:f.value)})),R))});Gc.displayName="SelectNative";function $1({activateOptionIndex:e,active:t,index:n,onClick:r,option:o,selected:l,setRef:i}){let s=(0,ge.useCallback)(()=>{e(n)},[e,n]),a=(0,ge.useCallback)(h=>{i(h,n)},[n,i]),c=Uc();return ge.default.createElement(c0,{active:t,"aria-selected":l?"true":void 0,"data-value":o.value,id:c,onClick:r,onMouseEnter:s,ref:a,role:"option",tabIndex:0},o.label)}function R1({"aria-label":e,"aria-labelledby":t,className:n,defaultValue:r,disabled:o=!1,formatDisplay:l,inputProps:i,labelId:s,menuMaxHeight:a,name:c,onBlur:h,onChange:p,onClose:g,onFocus:w,onKeyDown:v,onMouseDown:k,onOpen:R,open:d,options:u,readOnly:f,shadow:x=!0,style:S,variant:E="default",value:b,width:A="auto",...B},I){let{isEnabled:U,options:Z,setValue:q,value:ce,wrapperProps:xe,DropdownButton:Ve,Wrapper:He}=Ls({className:n,defaultValue:r,disabled:o,native:!1,onChange:p,options:u,style:S,readOnly:f,value:b,variant:E,width:A}),j=(0,ge.useRef)(null),ye=(0,ge.useRef)(null),Oe=(0,ge.useRef)(null),{activeOption:De,handleActivateOptionIndex:Ee,handleBlur:O,handleButtonKeyDown:N,handleDropdownKeyDown:K,handleFocus:V,handleMouseDown:M,handleOptionClick:J,handleSetDropdownRef:$,handleSetOptionRef:P,open:Y,selectedOption:de}=f0({onBlur:h,onChange:p,onClose:g,onFocus:w,onKeyDown:v,onMouseDown:k,onOpen:R,open:d,options:Z,value:ce,selectRef:ye,setValue:q,wrapperRef:Oe});(0,ge.useImperativeHandle)(I,()=>({focus:ir=>{var bn;(bn=ye.current)===null||bn===void 0||bn.focus(ir)},node:j.current,value:String(ce)}),[ce]);let se=(0,ge.useMemo)(()=>de?typeof l=="function"?l(de):de.label:"",[l,de]),Be=U?1:void 0,Ae=(0,ge.useMemo)(()=>a?{overflow:"auto",maxHeight:a}:void 0,[a]),wt=Uc(),tn=(0,ge.useMemo)(()=>Z.map((ir,bn)=>{let Js=`${ce}-${bn}`,ea=ir===De,$o=ir===de;return ge.default.createElement($1,{activateOptionIndex:Ee,active:ea,index:bn,key:Js,onClick:J,option:ir,selected:$o,setRef:P})}),[De,Ee,J,P,Z,de,ce]);return ge.default.createElement(He,{...xe,$disabled:o,ref:Oe,shadow:x,style:{...S,width:A}},ge.default.createElement("input",{name:c,ref:j,type:"hidden",value:String(ce),...i}),ge.default.createElement(Bl,{"aria-disabled":o,"aria-expanded":Y,"aria-haspopup":"listbox","aria-label":e,"aria-labelledby":t??s,"aria-owns":U&&Y?wt:void 0,onBlur:O,onFocus:V,onKeyDown:N,onMouseDown:U?M:k,ref:ye,role:"button",tabIndex:Be,...B},ge.default.createElement(r0,null,se),Ve),U&&Y&&ge.default.createElement(u0,{id:wt,onKeyDown:K,ref:$,role:"listbox",style:Ae,tabIndex:0,variant:E},tn))}var _r=(0,ge.forwardRef)(R1);_r.displayName="Select";var zs=D(L(),1);var _1=y.div`
  position: relative;
  display: flex;
  align-items: center;
  padding: ${e=>e.noPadding?"0":"4px"};
`,Nr=(0,zs.forwardRef)(function({children:t,noPadding:n=!1,...r},o){return zs.default.createElement(_1,{noPadding:n,ref:o,...r},t)});Nr.displayName="Toolbar";var Ml=D(L(),1);var Os=D(L(),1);var N1=y.div`
  padding: 16px;
`,xn=(0,Os.forwardRef)(function({children:t,...n},r){return Os.default.createElement(N1,{ref:r,...n},t)});xn.displayName="WindowContent";var Bs=D(L(),1);var I1=y.div`
  height: 33px;
  line-height: 33px;
  padding-left: 0.25rem;
  padding-right: 3px;
  font-weight: bold;
  border: 2px solid ${({theme:e})=>e.material};
  ${({active:e})=>e===!1?T`
          background: ${({theme:t})=>t.headerNotActiveBackground};
          color: ${({theme:t})=>t.headerNotActiveText};
        `:T`
          background: ${({theme:t})=>t.headerBackground};
          color: ${({theme:t})=>t.headerText};
        `}

  ${Kn} {
    padding-left: 0;
    padding-right: 0;
    height: 27px;
    width: 31px;
  }
`,wn=(0,Bs.forwardRef)(function({active:t=!0,children:n,...r},o){return Bs.default.createElement(I1,{active:t,ref:o,...r},n)});wn.displayName="WindowHeader";var D1=y.div`
  position: relative;
  padding: 4px;
  font-size: 1rem;
  ${X({style:"window"})}
  ${$e()}
`,P1=y.span`
  ${({theme:e})=>T`
    display: inline-block;
    position: absolute;
    bottom: 10px;
    right: 10px;
    width: 25px;
    height: 25px;
    background-image: linear-gradient(
      135deg,
      ${e.borderLightest} 16.67%,
      ${e.material} 16.67%,
      ${e.material} 33.33%,
      ${e.borderDark} 33.33%,
      ${e.borderDark} 50%,
      ${e.borderLightest} 50%,
      ${e.borderLightest} 66.67%,
      ${e.material} 66.67%,
      ${e.material} 83.33%,
      ${e.borderDark} 83.33%,
      ${e.borderDark} 100%
    );
    background-size: 8.49px 8.49px;
    clip-path: polygon(100% 0px, 0px 100%, 100% 100%);
    cursor: nwse-resize;
  `}
`,qn=(0,Ml.forwardRef)(({children:e,resizable:t=!1,resizeRef:n,shadow:r=!0,...o},l)=>Ml.default.createElement(D1,{ref:l,shadow:r,...o},e,t&&Ml.default.createElement(P1,{"data-testid":"resizeHandle",ref:n})));qn.displayName="Window";var L1=y(zl)`
  width: 234px;
  margin: 1rem 0;
  background: ${({theme:e})=>e.canvas};
`,z1=y.div`
  display: flex;
  background: ${({theme:e})=>e.materialDark};
  color: #dfe0e3;
`,O1=y.div`
  display: flex;
  flex-wrap: wrap;
`,kn=y.div`
  text-align: center;
  height: 1.5em;
  line-height: 1.5em;
  width: 14.28%;
`,B1=y.span`
  cursor: pointer;

  background: ${({active:e,theme:t})=>e?t.hoverBackground:"transparent"};
  color: ${({active:e,theme:t})=>e?t.canvasTextInvert:t.canvasText};

  &:hover {
    border: 2px dashed
      ${({theme:e,active:t})=>t?"none":e.materialDark};
  }
`,M1=[{value:0,label:"January"},{value:1,label:"February"},{value:2,label:"March"},{value:3,label:"April"},{value:4,label:"May"},{value:5,label:"June"},{value:6,label:"July"},{value:7,label:"August"},{value:8,label:"September"},{value:9,label:"October"},{value:10,label:"November"},{value:11,label:"December"}];function F1(e,t){return new Date(e,t+1,0).getDate()}function j1(e,t,n){return new Date(e,t,n).getDay()}function V1(e){let t=new Date(Date.parse(e)),n=t.getUTCDate(),r=t.getUTCMonth(),o=t.getUTCFullYear();return{day:n,month:r,year:o}}var p0=(0,W.forwardRef)(({className:e,date:t=new Date().toISOString(),onAccept:n,onCancel:r,shadow:o=!0},l)=>{let[i,s]=(0,W.useState)(()=>V1(t)),{year:a,month:c,day:h}=i,p=(0,W.useCallback)(({value:R})=>{s(d=>({...d,month:R}))},[]),g=(0,W.useCallback)(R=>{s(d=>({...d,year:R}))},[]),w=(0,W.useCallback)(R=>{s(d=>({...d,day:R}))},[]),v=(0,W.useCallback)(()=>{let R=[i.year,i.month+1,i.day].map(d=>String(d).padStart(2,"0")).join("-");n?.(R)},[i.day,i.month,i.year,n]),k=(0,W.useMemo)(()=>{let R=Array.from({length:42}),d=j1(a,c,1),u=h,f=F1(a,c);return u=u<f?u:f,R.forEach((x,S)=>{if(S>=d&&S<f+d){let E=S-d+1;R[S]=W.default.createElement(kn,{key:S,onClick:()=>{w(E)}},W.default.createElement(B1,{active:E===u},E))}else R[S]=W.default.createElement(kn,{key:S})}),R},[h,w,c,a]);return W.default.createElement(qn,{className:e,ref:l,shadow:o,style:{margin:20}},W.default.createElement(wn,null,W.default.createElement("span",{role:"img","aria-label":"\u{1F4C6}"},"\u{1F4C6}"),"Date"),W.default.createElement(xn,null,W.default.createElement(Nr,{noPadding:!0,style:{justifyContent:"space-between"}},W.default.createElement(_r,{options:M1,value:c,onChange:p,width:128,menuMaxHeight:200}),W.default.createElement(Ol,{value:a,onChange:g,width:100})),W.default.createElement(L1,null,W.default.createElement(z1,null,W.default.createElement(kn,null,"S"),W.default.createElement(kn,null,"M"),W.default.createElement(kn,null,"T"),W.default.createElement(kn,null,"W"),W.default.createElement(kn,null,"T"),W.default.createElement(kn,null,"F"),W.default.createElement(kn,null,"S")),W.default.createElement(O1,null,k)),W.default.createElement(Nr,{noPadding:!0,style:{justifyContent:"space-between"}},W.default.createElement(ue,{fullWidth:!0,onClick:r,disabled:!r},"Cancel"),W.default.createElement(ue,{fullWidth:!0,onClick:n?v:void 0,disabled:!n},"OK"))))});p0.displayName="DatePicker";var Ms=D(L(),1);var H1=e=>{switch(e){case"status":case"well":return T`
        ${X({style:"status"})}
      `;case"window":case"outside":return T`
        ${X({style:"window"})}
      `;case"field":return T`
        ${X({style:"field"})}
      `;default:return T`
        ${X()}
      `}},W1=y.div`
  position: relative;
  font-size: 1rem;
  ${({variant:e})=>H1(e)}
  ${({variant:e})=>$e(e==="field"?{background:"canvas",color:"canvasText"}:void 0)}
`,xt=(0,Ms.forwardRef)(({children:e,shadow:t=!1,variant:n="window",...r},o)=>Ms.default.createElement(W1,{ref:o,shadow:t,variant:n,...r},e));xt.displayName="Frame";var Fl=D(L(),1);var U1=y.fieldset`
  position: relative;
  border: 2px solid
    ${({theme:e,variant:t})=>t==="flat"?e.flatDark:e.borderLightest};
  padding: 16px;
  margin-top: 8px;
  font-size: 1rem;
  color: ${({theme:e})=>e.materialText};
  ${({variant:e})=>e!=="flat"&&T`
      box-shadow: -1px -1px 0 1px ${({theme:t})=>t.borderDark},
        inset -1px -1px 0 1px ${({theme:t})=>t.borderDark};
    `}
  ${e=>e.$disabled&&Re()}
`,Q1=y.legend`
  display: flex;
  position: absolute;
  top: 0;
  left: 8px;
  transform: translateY(calc(-50% - 2px));
  padding: 0 8px;

  font-size: 1rem;
  background: ${({theme:e,variant:t})=>t==="flat"?e.canvas:e.material};
`,Jn=(0,Fl.forwardRef)(({label:e,disabled:t=!1,variant:n="default",children:r,...o},l)=>Fl.default.createElement(U1,{"aria-disabled":t,$disabled:t,variant:n,ref:l,...o},e&&Fl.default.createElement(Q1,{variant:n},e),r));Jn.displayName="GroupBox";var Kc=y.div`
  ${({theme:e,size:t="100%"})=>`
  display: inline-block;
  box-sizing: border-box;
  height: ${dt(t)};
  width: 5px;
  border-top: 2px solid ${e.borderLightest};
  border-left: 2px solid ${e.borderLightest};
  border-bottom: 2px solid ${e.borderDark};
  border-right: 2px solid ${e.borderDark};
  background: ${e.material};
`}
`;Kc.displayName="Handle";var jl=D(L(),1);var m0="url('data:image/gif;base64,R0lGODlhPAA8APQAADc3N6+vr4+Pj05OTvn5+V1dXZ+fn29vby8vLw8PD/X19d/f37S0tJSUlLq6und3d39/f9XV1c/Pz+bm5qamphkZGWZmZsbGxr+/v+rq6tra2u/v7yIiIv///wAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFBAAfACH+I1Jlc2l6ZWQgb24gaHR0cHM6Ly9lemdpZi5jb20vcmVzaXplACwAAAAAPAA8AAAF/+AnjmRpnmiqrmzrvnAsz3Rt37jr7Xzv/8BebhQsGn1D0XFZTH6YUGQySvU4fYKAdsvtdi1Cp3In6ZjP6HTawBMTyWbFYk6v18/snXvsKXciUApmeVZ7PH6ATIIdhHtPcB0TDQ1gQBCTBINthpBnAUEaa5tuh2mfQKFojZx9aRMSEhA7FLAbonqsfmoUOxFqmriknWm8Hr6/q8IeCAAAx2cTERG2aBTNHMGOj8a/v8WF2m/c3cSj4SQ8C92n4Ocm6evm7ui9CosdBPbs8yo8E2YO5PE74Q+gwIElCnYImA3hux3/Fh50yCciw3YUt2GQtiiDtGQO4f3al1GkGpIDeXlg0KDhXpoMLBtMVPaMnJlv/HjUtIkzHA8HEya4tLkhqICGV4bZVAMyaaul3ZpOUQoVz8wbpaoyvWojq1ZVXGt4/QoM49SnZMs6GktW6hC2X93mgKtVbtceWbzo9VIJKdYqUJwCPiJ4cJOzhg+/TWwko+PHkCNLdhgCACH5BAUEAB8ALAAAAAABAAEAAAUD4BcCACH5BAUEAB8ALBYADAAQAA0AAAVFYCeOZPmVaKqimeO+MPxFXv3d+F17Cm3nuJ1ic7lAdroapUjABZCfnQb4ef6k1OHGULtsNk3qjVKLiIFkj/mMIygU4VwIACH5BAUEAB8ALAAAAAABAAEAAAUD4BcCACH5BAUEAB8ALBkAIwAKAAcAAAUp4CdehrGI6Ed5XpSKa4teguBoGlVPAXuJBpam5/l9gh7NZrFQiDJMRQgAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsFgAPABAAIQAABVBgJ45kaZ5oakZB67bZ+M10bd94ru987//AoHBILNYYAsGlR/F4IkwnlLeZTBQ9UlaWwzweERHjuzAKFZkMYYZWm4mOw0ETfdanO8Vms7aFAAAh+QQFBAAfACwAAAAAAQABAAAFA+AXAgAh+QQFBAAfACwZABIACgAeAAAFUGAnjmRpnij5rerqtu4Hx3Rt33iu758iZrUZa1TDCASLGsXjiSiZzmFnM5n4TNJSdmREElfL5lO8cgwGACbgrAkwPat3+x1naggKRS+f/4QAACH5BAUEAB8ALAAAAAABAAEAAAUD4BcCACH5BAUEAB8ALBYAIwAQAA0AAAVE4CeOXdmNaGqeabu27SUIC5xSnifZKK7zl8djkCsIaylGziNaakaEzcbH/Cwl0k9kuWxyPYptzrZULA7otFpNIK1eoxAAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkEBQQAHwAsAAAAAAEAAQAABQPgFwIAIfkECQQAHwAsDgAEACAANAAABTHgJ45kaZ5oqq5s675wLM90bd94ru987//AoHBILBqPyKRyyWw6n9CodEqtWq/Y7CoEACH5BAUEAB8ALAAAAAA8ADwAAAX/4CeOZGmeaKqubFt6biy3Xj3fuFjveU/vPJ/wBAQOj6RiEClUGpk9IMAJxQEdmQK1Grt2OhutkvurOb7f8JaM8qLT4iKbuDu/0erxfOS+4+NPex9mfn55coIfCAuFhoBLbDUAjI1vh4FkOxSVd5eQXB4GnI5rXAAbo6R6VTUFqKmWjzasNaKwsaVIHhAEt3cLTjBQA6++XwoHuUM1vMYdyMorwoN8wkC2t9A8s102204Wxana3DNAAQO1FjUCEDXhvuTT5nUdEwOiGxa8BBDwXxKaLTiAKoMFRvJy9CmmoFcHAgrQSEiwKwICDwU0pAMQIdmnboR8TfwWrJyMPrAiz1DkNs2aSRbe6hnr99LEvDJ9IB5DQ8Dhm36glNh5COGBAmQNHrbz+WXBFChOTqFx5+GBxwYCmL1ZcPHmMiWuvkTgECzBBUvrvH4tErbDWCcYDB2IBPbV2yJJ72SZ46TtXSB5v2RIp1ZXXbFkgWxCc68mk752E3tY/OZeIsiIaxi9o+BBokGH3SZ+4FPbZ8yiPQxNeDl0hNUeHWcKjYb1Zx20bd/GzRaV7t28gRSYELvw7pIfgVcLplwF8+bOo0Ffjmm6zerWrxvPzoe79w8hAAAh+QQJBAAfACwBAAEAOgA6AAAFRuAnjmRpnmiqrmzrvnAsz3Rt33iu73zv/8CgcEgsGo/IpHLJbDqf0Kh0Sq1ar9isdsvter/gsHhMLpvP6LR6zW673/D4MgQAIfkEBQQAHwAsAAAAADwAPAAABf/gJ45kaZ5oqq5s675wLM90bd94ru987//AoHBILBqPyJxnyTQym6nn0ilVSa9XGHY7jXKx2m/WK36Gy1CUVCBpu9+OtNqDeNslgip5Gej4/4ATcidLAICHHQF6c0x9iH+CXV6Gj36KZnsejgsREQSACp0Yg0ydEZWWi4RPjgdLG48apEuogJeDJVKtr7GzHrV/t5KrjX6uHhQMF4cKCwujTxHOwKmYjHzGTw+VEVIK1MGqJrrZTNuP3U/f4IniuazlSwMUFMugE/j47NW4JOQdx9bsoybMgxV4ALEIGAis4MFiCZkUaLPgUAYHGDF+Yucw0y5z3Lzt63hNUzwP5xCRpWOyDhxJYtgiStBQEVCGAAEM6MLp0p0/hMdgIZI17AOTntZgmowo9BBRgz9/EfQ54h8BBS39bKDXwBc9CrVejkNYKRLUSWGpivhXtt9PSpXEvmNiwYDdu3jzFB3LAa9fAxbUGkXjtmSZh4TPJM4kRgbhvVEL9xhTEongJJgza97MubPnz6BDix5NurTp0yJCAAAh+QQJBAAfACwEAA4ANAAgAAAFMeAnjmRpnmiqrmzrvnAsz3Rt33iu73zv/8CgcEgsGo/IpHLJbDqf0Kh0Sq1ar9jsKgQAIfkEBQQAHwAsAAAAADwAPAAABf/gJ45kaZ5oqq5s6bVwLHu0bN8uXeM8rP+9YOoHFBpHRN1xmSwue02A82lrFjaOKbVl3XQ6WeWWm7x+v+HdeFj2ntHaNbL9jUAI5/RLTurWOR53eXFbfh0RgB4PCm9hfCKGiDSLb18Bjx+RiR4HjG8TA3trmkSdZxuhalSkRA2VBqpPrD+ulR0Go3SHmz8CeG8bFqJMupJNHr5nCsKxQccTg4oUNA0YCYG/HQQQYsSlnmCUFLUXgm8EAsPeP6Zf2baV2+rEmTrt8PDyzS7O9uD4b5YV2VGjGw52/wB+CaYjlQcpNBAQioHwy4QMCxe4i3BKGIQN3K7AArBATz8anUDADcgQDMGCbQkknDKAh4ABNxQ0gpnoQ8eDVAUO0ADAzUNMhbZMQiG4R4mOo0gb8eTCQgeEqJVM7juCDWvWJnI4ev2aZIwHl2PfZIBIZBXKtAsLgC1kJu0GuWXNaoB7d67ZlWP75jVLw4JXwW35PNSJFPFUrmIb402smFNCW44N5kJ5+dTkx+vuAfus+VHF0X4xzeHsObXq1ZY7ZN76mt0C0rRf1zuWW/du175PHAu+YjhxFcCPm6CsHHnv5kig6w4BACH5BAkEAB8ALAEAAQA6ADoAAAVG4CeOZGmeaKqubOu+cCzPdG3feK7vfO//wKBwSCwaj8ikcslsOp/QqHRKrVqv2Kx2y+16v+CweEwum8/otHrNbrvf8PgyBAAh+QQFBAAfACwAAAAAPAA8AAAF/+AnjmRpnmiqrmzrvnAsz3Rt37jr7Xzv/8BebhQsGn1D0XFZTH6YUGQySvU4fYKAdsvtdi1Cp3In6ZjP6HTawBMTyWbFYk6v18/snXvsKXciUApmeVZ7PH6ATIIdhHtPcB0TDQ1gQBCTBINthpBnAUEaa5tuh2mfQKFojZx9aRMSEhA7FLAbonqsfmoUOxFqmriknWm8Hr6/q8IeCAAAx2cTERG2aBTNHMGOj8a/v8WF2m/c3cSj4SQ8C92n4Ocm6evm7ui9CosdBPbs8yo8E2YO5PE74Q+gwIElCnYImA3hux3/Fh50yCciw3YUt2GQtiiDtGQO4f3al1GkGpIDeXlg0KDhXpoMLBtMVPaMnJlv/HjUtIkzHA8HEya4tLkhqICGV4bZVAMyaaul3ZpOUQoVz8wbpaoyvWojq1ZVXGt4/QoM49SnZMs6GktW6hC2X93mgKtVbtceWbzo9VIJKdYqUJwCPiJ4cJOzhg+/TWwko+PHkCNLdhgCACH5BAUEAB8ALAAAAAABAAEAAAUD4BcCADs=')";var G1=y.div`
  display: inline-block;
  height: ${({size:e})=>dt(e)};
  width: ${({size:e})=>dt(e)};
`,K1=y.span`
  display: block;
  background: ${m0};
  background-size: cover;
  width: 100%;
  height: 100%;
`,h0=(0,jl.forwardRef)(({size:e=30,...t},n)=>jl.default.createElement(G1,{size:e,ref:n,...t},jl.default.createElement(K1,null)));h0.displayName="Hourglass";var er=D(L(),1);var Y1=y.div`
  position: relative;
  display: inline-block;
  padding-bottom: 26px;
`,X1=y.div`
  position: relative;
`,Z1=y.div`
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  width: 195px;
  height: 155px;
  padding: 12px;
  background: ${({theme:e})=>e.material};
  border-top: 4px solid ${({theme:e})=>e.borderLightest};
  border-left: 4px solid ${({theme:e})=>e.borderLightest};
  border-bottom: 4px solid ${({theme:e})=>e.borderDark};
  border-right: 4px solid ${({theme:e})=>e.borderDark};

  outline: 1px dotted ${({theme:e})=>e.material};
  outline-offset: -3px;
  &:before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    outline: 1px dotted ${({theme:e})=>e.material};
  }
  box-shadow: 1px 1px 0 1px ${({theme:e})=>e.borderDarkest};

  &:after {
    content: '';
    display: inline-block;
    position: absolute;
    bottom: 4px;
    right: 12px;
    width: 10px;
    border-top: 2px solid #4d9046;
    border-bottom: 2px solid #07ff00;
  }
`,q1=y(_e).attrs(()=>({"data-testid":"background"}))`
  width: 100%;
  height: 100%;
`,J1=y.div`
  box-sizing: border-box;
  position: absolute;
  top: calc(100% + 2px);
  left: 50%;
  transform: translateX(-50%);
  height: 10px;
  width: 50%;
  background: ${({theme:e})=>e.material};
  border-left: 2px solid ${({theme:e})=>e.borderLightest};
  border-bottom: 2px solid ${({theme:e})=>e.borderDarkest};
  border-right: 2px solid ${({theme:e})=>e.borderDarkest};
  box-shadow: inset 0px 0px 0px 2px ${({theme:e})=>e.borderDark};

  &:before {
    content: '';
    position: absolute;
    top: calc(100% + 2px);
    left: 50%;
    transform: translateX(-50%);
    width: 80%;
    height: 8px;
    background: ${({theme:e})=>e.material};
    border-left: 2px solid ${({theme:e})=>e.borderLightest};
    border-right: 2px solid ${({theme:e})=>e.borderDarkest};
    box-shadow: inset 0px 0px 0px 2px ${({theme:e})=>e.borderDark};
  }
  &:after {
    content: '';
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    width: 150%;
    height: 4px;
    background: ${({theme:e})=>e.material};
    border: 2px solid ${({theme:e})=>e.borderDark};
    border-bottom: none;
    box-shadow: inset 1px 1px 0px 1px ${({theme:e})=>e.borderLightest},
      1px 1px 0 1px ${({theme:e})=>e.borderDarkest};
  }
`,Yc=(0,er.forwardRef)(({backgroundStyles:e,children:t,...n},r)=>er.default.createElement(Y1,{ref:r,...n},er.default.createElement(X1,null,er.default.createElement(Z1,null,er.default.createElement(q1,{style:e},t)),er.default.createElement(J1,null))));Yc.displayName="Monitor";var Ne=D(L(),1);var ex=y.div`
  display: inline-block;
  height: ${ie.md};
  width: 100%;
`,tx=y(_e)`
  width: 100%;
  height: 100%;
  position: relative;
  text-align: center;
  padding: 0;
  overflow: hidden;
  &:before {
    z-index: 1;
  }
`,g0=T`
  width: calc(100% - 4px);
  height: calc(100% - 4px);

  display: flex;
  align-items: center;
  justify-content: space-around;
`,nx=y.div`
  position: relative;
  top: 4px;
  ${g0}
  background: ${({theme:e})=>e.canvas};
  color: #000;
  margin-left: 2px;
  margin-top: -2px;
  color: ${({theme:e})=>e.materialText};
`,rx=y.div`
  position: absolute;
  top: 2px;
  left: 2px;
  ${g0}
  color: ${({theme:e})=>e.materialTextInvert};
  background: ${({theme:e})=>e.progress};
  clip-path: polygon(
    0 0,
    ${({value:e=0})=>e}% 0,
    ${({value:e=0})=>e}% 100%,
    0 100%
  );
  transition: 0.4s linear clip-path;
`,ox=y.div`
  width: calc(100% - 6px);
  height: calc(100% - 8px);
  position: absolute;
  left: 3px;
  top: 4px;
  box-sizing: border-box;
  display: inline-flex;
`,y0=17,lx=y.span`
  display: inline-block;
  width: ${y0}px;
  box-sizing: border-box;
  height: 100%;
  background: ${({theme:e})=>e.progress};
  border-color: ${({theme:e})=>e.material};
  border-width: 0px 1px;
  border-style: solid;
`,Vl=(0,Ne.forwardRef)(({hideValue:e=!1,shadow:t=!0,value:n,variant:r="default",...o},l)=>{let i=e?null:`${n}%`,s=(0,Ne.useRef)(null),[a,c]=(0,Ne.useState)([]),h=(0,Ne.useCallback)(()=>{if(!s.current||n===void 0)return;let p=s.current.getBoundingClientRect().width,g=Math.round(n/100*p/y0);c(Array.from({length:g}))},[n]);return(0,Ne.useEffect)(()=>(h(),window.addEventListener("resize",h),()=>window.removeEventListener("resize",h)),[h]),Ne.default.createElement(ex,{"aria-valuenow":n!==void 0?Math.round(n):void 0,ref:l,role:"progressbar",variant:r,...o},Ne.default.createElement(tx,{variant:r,shadow:t},r==="default"?Ne.default.createElement(Ne.default.Fragment,null,Ne.default.createElement(nx,{"data-testid":"defaultProgress1"},i),Ne.default.createElement(rx,{"data-testid":"defaultProgress2",value:n},i)):Ne.default.createElement(ox,{ref:s,"data-testid":"tileProgress"},a.map((p,g)=>Ne.default.createElement(lx,{key:g})))))});Vl.displayName="ProgressBar";var tr=D(L(),1);var v0=T`
  width: ${Nt}px;
  height: ${Nt}px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: space-around;
  margin-right: 0.5rem;
`,ix=y(_e)`
  ${v0}
  background: ${({$disabled:e,theme:t})=>e?t.material:t.canvas};

  &:before {
    content: '';
    position: absolute;
    left: 0px;
    top: 0px;
    width: calc(100% - 4px);
    height: calc(100% - 4px);
    border-radius: 50%;
    box-shadow: none;
  }
`,sx=y.div`
  ${_t()}
  ${v0}
  outline: none;
  background: ${({$disabled:e,theme:t})=>e?t.flatLight:t.canvas};
  &:before {
    content: '';
    display: inline-block;
    position: absolute;
    top: 0;
    left: 0;
    width: calc(100% - 4px);
    height: calc(100% - 4px);
    border: 2px solid ${({theme:e})=>e.flatDark};
    border-radius: 50%;
  }
`,ax=y.span.attrs(()=>({"data-testid":"checkmarkIcon"}))`
  position: absolute;
  content: '';
  display: inline-block;
  top: 50%;
  left: 50%;
  width: 6px;
  height: 6px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: ${e=>e.$disabled?e.theme.checkmarkDisabled:e.theme.checkmark};
`,ux={flat:sx,default:ix},Eo=(0,tr.forwardRef)(({checked:e,className:t="",disabled:n=!1,label:r="",onChange:o,style:l={},variant:i="default",...s},a)=>{let c=ux[i];return tr.default.createElement(So,{$disabled:n,className:t,style:l},tr.default.createElement(c,{$disabled:n,role:"presentation"},e&&tr.default.createElement(ax,{$disabled:n,variant:i})),tr.default.createElement(ko,{disabled:n,onChange:n?void 0:o,readOnly:n,type:"radio",checked:e,ref:a,...s}),r&&tr.default.createElement(bo,null,r))});Eo.displayName="Radio";var ke=D(L(),1);var nr=D(L(),1),cx=typeof window<"u"?nr.useLayoutEffect:nr.useEffect;function rr(e){let t=nr.useRef(e);return cx(()=>{t.current=e}),nr.useCallback((...n)=>(0,t.current)(...n),[])}var w0=D(L(),1);function x0(e,t){typeof e=="function"?e(t):e&&(e.current=t)}function Xc(e,t){return(0,w0.useMemo)(()=>e==null&&t==null?null:n=>{x0(e,n),x0(t,n)},[e,t])}var S0=D(L(),1),b0=D(xc(),1),Fs=!0,qc=!1,k0,dx={text:!0,search:!0,url:!0,tel:!0,email:!0,password:!0,number:!0,date:!0,month:!0,week:!0,time:!0,datetime:!0,"datetime-local":!0};function fx(e){if("type"in e){let{type:t,tagName:n}=e;if(n==="INPUT"&&dx[t]&&!e.readOnly||n==="TEXTAREA"&&!e.readOnly)return!0}return!!("isContentEditable"in e&&e.isContentEditable)}function px(e){e.metaKey||e.altKey||e.ctrlKey||(Fs=!0)}function Zc(){Fs=!1}function mx(){this.visibilityState==="hidden"&&qc&&(Fs=!0)}function hx(e){e.addEventListener("keydown",px,!0),e.addEventListener("mousedown",Zc,!0),e.addEventListener("pointerdown",Zc,!0),e.addEventListener("touchstart",Zc,!0),e.addEventListener("visibilitychange",mx,!0)}function gx(e){let{target:t}=e;try{return t.matches(":focus-visible")}catch{}return Fs||fx(t)}function yx(){qc=!0,window.clearTimeout(k0),k0=window.setTimeout(()=>{qc=!1},100)}function E0(){let e=(0,S0.useCallback)(t=>{let n=(0,b0.findDOMNode)(t);n!=null&&hx(n.ownerDocument)},[]);return{isFocusVisible:gx,onBlurVisible:yx,ref:e}}function vx(e,t,n){return(n-t)*e+t}function js(e,t){if(t!==void 0&&"changedTouches"in e){for(let n=0;n<e.changedTouches.length;n+=1){let r=e.changedTouches[n];if(r.identifier===t)return{x:r.clientX,y:r.clientY}}return!1}return"clientX"in e?{x:e.clientX,y:e.clientY}:!1}function Vs(e){return e&&e.ownerDocument||document}function xx(e,t){var n;let{index:r}=(n=e.reduce((o,l,i)=>{let s=Math.abs(t-l);return o===null||s<o.distance||s===o.distance?{distance:s,index:i}:o},null))!==null&&n!==void 0?n:{};return r??-1}var wx=y.div`
  display: inline-block;
  position: relative;
  touch-action: none;
  &:before {
    content: '';
    display: inline-block;
    position: absolute;
    top: -2px;
    left: -15px;
    width: calc(100% + 30px);
    height: ${({hasMarks:e})=>e?"41px":"39px"};
    ${({isFocused:e,theme:t})=>e&&`
        outline: 2px dotted ${t.materialText};
        `}
  }

  ${({orientation:e,size:t})=>e==="vertical"?T`
          height: ${t};
          margin-right: 1.5rem;
          &:before {
            left: -6px;
            top: -15px;
            height: calc(100% + 30px);
            width: ${({hasMarks:n})=>n?"41px":"39px"};
          }
        `:T`
          width: ${t};
          margin-bottom: 1.5rem;
          &:before {
            top: -2px;
            left: -15px;
            width: calc(100% + 30px);
            height: ${({hasMarks:n})=>n?"41px":"39px"};
          }
        `}

  pointer-events: ${({$disabled:e})=>e?"none":"auto"};
`,A0=()=>T`
  position: absolute;
  ${({orientation:e})=>e==="vertical"?T`
          bottom: 0;
          left: 50%;
          transform: translateX(-50%);
          height: 100%;
          width: 8px;
        `:T`
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          height: 8px;
          width: 100%;
        `}
`,kx=y(_e)`
  ${A0()}
`,Sx=y(_e)`
  ${A0()}

  border-left-color: ${({theme:e})=>e.flatLight};
  border-top-color: ${({theme:e})=>e.flatLight};
  border-right-color: ${({theme:e})=>e.canvas};
  border-bottom-color: ${({theme:e})=>e.canvas};
  &:before {
    border-left-color: ${({theme:e})=>e.flatDark};
    border-top-color: ${({theme:e})=>e.flatDark};
    border-right-color: ${({theme:e})=>e.flatLight};
    border-bottom-color: ${({theme:e})=>e.flatLight};
  }
`,bx=y.span`
  position: relative;
  ${({orientation:e})=>e==="vertical"?T`
          width: 32px;
          height: 18px;
          right: 2px;
          transform: translateY(-50%);
        `:T`
          height: 32px;
          width: 18px;
          top: 2px;
          transform: translateX(-50%);
        `}
  ${({variant:e})=>e==="flat"?T`
          ${_t()}
          outline: 2px solid ${({theme:t})=>t.flatDark};
          background: ${({theme:t})=>t.flatLight};
        `:T`
          ${$e()}
          ${X()}
          &:focus {
            outline: none;
          }
        `}
    ${({$disabled:e,theme:t})=>e&&gn({mainColor:t.material,secondaryColor:t.borderLightest})}
`,Ao=6,Ex=y.span`
  display: inline-block;
  position: absolute;

  ${({orientation:e})=>e==="vertical"?T`
          right: ${-Ao-2}px;
          bottom: 0px;
          transform: translateY(1px);
          width: ${Ao}px;
          border-bottom: 2px solid ${({theme:t})=>t.materialText};
        `:T`
          bottom: ${-Ao}px;
          height: ${Ao}px;
          transform: translateX(-1px);
          border-left: 1px solid ${({theme:t})=>t.materialText};
          border-right: 1px solid ${({theme:t})=>t.materialText};
        `}

  color:  ${({theme:e})=>e.materialText};
  ${({$disabled:e,theme:t})=>e&&T`
      ${Re()}
      box-shadow: 1px 1px 0px ${t.materialTextDisabledShadow};
      border-color: ${t.materialTextDisabled};
    `}
`,Ax=y.div`
  position: absolute;
  bottom: 0;
  left: 0;
  line-height: 1;
  font-size: 0.875rem;

  ${({orientation:e})=>e==="vertical"?T`
          transform: translate(${Ao+2}px, ${Ao+1}px);
        `:T`
          transform: translate(-0.5ch, calc(100% + 2px));
        `}
`,C0=(0,ke.forwardRef)(({defaultValue:e,disabled:t=!1,marks:n=!1,max:r=100,min:o=0,name:l,onChange:i,onChangeCommitted:s,onMouseDown:a,orientation:c="horizontal",size:h="100%",step:p=1,value:g,variant:w="default",...v},k)=>{let R=w==="flat"?Sx:kx,d=c==="vertical",[u=o,f]=tt({defaultValue:e,onChange:i??s,value:g}),{isFocusVisible:x,onBlurVisible:S,ref:E}=E0(),[b,A]=(0,ke.useState)(!1),B=(0,ke.useRef)(),I=(0,ke.useRef)(null),U=Xc(E,B),Z=Xc(k,U),q=rr(O=>{x(O)&&A(!0)}),ce=rr(()=>{b!==!1&&(A(!1),S())}),xe=(0,ke.useRef)(),Ve=(0,ke.useMemo)(()=>n===!0&&Number.isFinite(p)?[...Array(Math.round((r-o)/p)+1)].map((O,N)=>({label:void 0,value:o+p*N})):Array.isArray(n)?n:[],[n,r,o,p]),He=rr(O=>{let N=(r-o)/10,K=Ve.map(J=>J.value),V=K.indexOf(u),M=0;switch(O.key){case"Home":M=o;break;case"End":M=r;break;case"PageUp":p&&(M=u+N);break;case"PageDown":p&&(M=u-N);break;case"ArrowRight":case"ArrowUp":p?M=u+p:M=K[V+1]||K[K.length-1];break;case"ArrowLeft":case"ArrowDown":p?M=u-p:M=K[V-1]||K[0];break;default:return}O.preventDefault(),p&&(M=jc(M,p,o)),M=Zt(M,o,r),f(M),A(!0),i?.(M),s?.(M)}),j=(0,ke.useCallback)(O=>{if(!B.current)return 0;let N=B.current.getBoundingClientRect(),K;d?K=(N.bottom-O.y)/N.height:K=(O.x-N.left)/N.width;let V;if(V=vx(K,o,r),p)V=jc(V,p,o);else{let M=Ve.map($=>$.value),J=xx(M,V);V=M[J]}return V=Zt(V,o,r),V},[Ve,r,o,p,d]),ye=rr(O=>{var N;let K=js(O,xe.current);if(!K)return;let V=j(K);(N=I.current)===null||N===void 0||N.focus(),f(V),A(!0),i?.(V)}),Oe=rr(O=>{let N=js(O,xe.current);if(!N)return;let K=j(N);s?.(K),xe.current=void 0;let V=Vs(B.current);V.removeEventListener("mousemove",ye),V.removeEventListener("mouseup",Oe),V.removeEventListener("touchmove",ye),V.removeEventListener("touchend",Oe)}),De=rr(O=>{var N;a?.(O),O.preventDefault(),(N=I.current)===null||N===void 0||N.focus(),A(!0);let K=js(O,xe.current);if(K){let M=j(K);f(M),i?.(M)}let V=Vs(B.current);V.addEventListener("mousemove",ye),V.addEventListener("mouseup",Oe)}),Ee=rr(O=>{var N;O.preventDefault();let K=O.changedTouches[0];K!=null&&(xe.current=K.identifier),(N=I.current)===null||N===void 0||N.focus(),A(!0);let V=js(O,xe.current);if(V){let J=j(V);f(J),i?.(J)}let M=Vs(B.current);M.addEventListener("touchmove",ye),M.addEventListener("touchend",Oe)});return(0,ke.useEffect)(()=>{let{current:O}=B;O?.addEventListener("touchstart",Ee);let N=Vs(O);return()=>{O?.removeEventListener("touchstart",Ee),N.removeEventListener("mousemove",ye),N.removeEventListener("mouseup",Oe),N.removeEventListener("touchmove",ye),N.removeEventListener("touchend",Oe)}},[Oe,ye,Ee]),ke.default.createElement(wx,{$disabled:t,hasMarks:!!Ve.length,isFocused:b,onMouseDown:De,orientation:c,ref:Z,size:dt(h),...v},ke.default.createElement("input",{disabled:t,name:l,type:"hidden",value:u??0}),Ve&&Ve.map(O=>ke.default.createElement(Ex,{$disabled:t,"data-testid":"tick",key:O.value/(r-o)*100,orientation:c,style:{[d?"bottom":"left"]:`${(O.value-o)/(r-o)*100}%`}},O.label&&ke.default.createElement(Ax,{"aria-hidden":!0,"data-testid":"mark",orientation:c},O.label))),ke.default.createElement(R,{orientation:c,variant:w}),ke.default.createElement(bx,{$disabled:t,"aria-disabled":t?!0:void 0,"aria-orientation":c,"aria-valuemax":r,"aria-valuemin":o,"aria-valuenow":u,onBlur:ce,onFocus:q,onKeyDown:He,orientation:c,ref:I,role:"slider",style:{[d?"bottom":"left"]:`${(d?-100:0)+100*(u-o)/(r-o)}%`},tabIndex:t?void 0:0,variant:w}))});C0.displayName="Slider";var Wl=D(L(),1);var Hs=D(L(),1);var Cx=y.tbody`
  background: ${({theme:e})=>e.canvas};
  display: table-row-group;
  box-shadow: ${Il};
  overflow-y: auto;
`,Co=(0,Hs.forwardRef)(function({children:t,...n},r){return Hs.default.createElement(Cx,{ref:r,...n},t)});Co.displayName="TableBody";var Ws=D(L(),1);var Tx=y.td`
  padding: 0 8px;
`,rt=(0,Ws.forwardRef)(function({children:t,...n},r){return Ws.default.createElement(Tx,{ref:r,...n},t)});rt.displayName="TableDataCell";var Us=D(L(),1);var $x=y.thead`
  display: table-header-group;
`,To=(0,Us.forwardRef)(function({children:t,...n},r){return Us.default.createElement($x,{ref:r,...n},t)});To.displayName="TableHead";var Hl=D(L(),1);var Rx=y.th`
  position: relative;
  padding: 0 8px;
  display: table-cell;
  vertical-align: inherit;
  background: ${({theme:e})=>e.material};
  cursor: default;
  user-select: none;
  &:before {
    box-sizing: border-box;
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    ${X()}

    border-left: none;
    border-top: none;
  }
  ${({$disabled:e})=>!e&&T`
      &:active {
        &:before {
          ${X({invert:!0,style:"window"})}
          border-left: none;
          border-top: none;
          padding-top: 2px;
        }

        & > div {
          position: relative;
          top: 2px;
        }
      }
    `}

  color: ${({theme:e})=>e.materialText};
  ${({$disabled:e})=>e&&Re()}
  &:hover {
    color: ${({theme:e})=>e.materialText};
    ${({$disabled:e})=>e&&Re()}
  }
`,ot=(0,Hl.forwardRef)(function({disabled:t=!1,children:n,onClick:r,onTouchStart:o=ct,sort:l,...i},s){let a=l==="asc"?"ascending":l==="desc"?"descending":void 0;return Hl.default.createElement(Rx,{$disabled:t,"aria-disabled":t,"aria-sort":a,onClick:t?void 0:r,onTouchStart:t?void 0:o,ref:s,...i},Hl.default.createElement("div",null,n))});ot.displayName="TableHeadCell";var Qs=D(L(),1);var _x=y.tr`
  color: inherit;
  display: table-row;
  height: calc(${ie.md} - 2px);
  line-height: calc(${ie.md} - 2px);
  vertical-align: middle;
  outline: none;

  color: ${({theme:e})=>e.canvasText};
  &:hover {
    background: ${({theme:e})=>e.hoverBackground};
    color: ${({theme:e})=>e.canvasTextInvert};
  }
`,or=(0,Qs.forwardRef)(function({children:t,...n},r){return Qs.default.createElement(_x,{ref:r,...n},t)});or.displayName="TableRow";var Nx=y.table`
  display: table;
  width: 100%;
  border-collapse: collapse;
  border-spacing: 0;
  font-size: 1rem;
`,Ix=y(_e)`
  &:before {
    box-shadow: none;
  }
`,Ul=(0,Wl.forwardRef)(({children:e,...t},n)=>Wl.default.createElement(Ix,null,Wl.default.createElement(Nx,{ref:n,...t},e)));Ul.displayName="Table";var Jt=D(L(),1);var Gs=D(L(),1);var Dx=y.button`
  ${$e()}
  ${X()}
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  height: ${ie.md};
  line-height: ${ie.md};
  padding: 0 8px;
  border-bottom: none;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
  margin: 0 0 -2px 0;
  cursor: default;
  color: ${({theme:e})=>e.materialText};
  user-select: none;
  font-family: inherit;
  &:focus:after,
  &:active:after {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    ${Xt}
    outline-offset: -6px;
  }
  ${e=>e.selected&&`
    z-index: 1;
    height: calc(${ie.md} + 4px);
    top: -4px;
    margin-bottom: -6px;
    padding: 0 16px;
    margin-left: -8px;
    &:not(:last-child) {
      margin-right: -8px;
    }
  `}
  &:before {
    content: '';
    position: absolute;
    width: calc(100% - 4px);
    height: 6px;
    background: ${({theme:e})=>e.material};
    bottom: -4px;
    left: 2px;
  }
`,lr=(0,Gs.forwardRef)(({value:e,onClick:t,selected:n=!1,children:r,...o},l)=>Gs.default.createElement(Dx,{"aria-selected":n,selected:n,onClick:i=>t?.(e,i),ref:l,role:"tab",...o},r));lr.displayName="Tab";var Ks=D(L(),1);var Px=y.div`
  ${$e()}
  ${X()}
  position: relative;
  display: block;
  height: 100%;
  padding: 16px;
  font-size: 1rem;
`,Ql=(0,Ks.forwardRef)(({children:e,...t},n)=>Ks.default.createElement(Px,{ref:n,...t},e));Ql.displayName="TabBody";var Lx=y.div`
  position: relative;
  ${({isMultiRow:e,theme:t})=>e&&`
  button {
    flex-grow: 1;
  }
  button:last-child:before {
    border-right: 2px solid ${t.borderDark};
  }
  `}
`,zx=y.div.attrs(()=>({"data-testid":"tab-row"}))`
  position: relative;
  display: flex;
  flex-wrap: no-wrap;
  text-align: left;
  left: 8px;
  width: calc(100% - 8px);

  &:not(:first-child):before {
    content: '';
    position: absolute;
    right: 0;
    left: 0;
    height: 100%;
    border-right: 2px solid ${({theme:e})=>e.borderDarkest};
    border-left: 2px solid ${({theme:e})=>e.borderLightest};
  }
`;function Ox(e,t){let n=[];for(let r=t;r>0;r-=1)n.push(e.splice(0,Math.ceil(e.length/r)));return n}var Ys=(0,Jt.forwardRef)(({value:e,onChange:t=ct,children:n,rows:r=1,...o},l)=>{let i=(0,Jt.useMemo)(()=>{var s;let a=(s=Jt.default.Children.map(n,p=>{if(!Jt.default.isValidElement(p))return null;let g={selected:p.props.value===e,onClick:t};return Jt.default.cloneElement(p,g)}))!==null&&s!==void 0?s:[],c=Ox(a,r).map((p,g)=>({key:g,tabs:p})),h=c.findIndex(p=>p.tabs.some(g=>g.props.selected));return c.push(c.splice(h,1)[0]),c},[n,t,r,e]);return Jt.default.createElement(Lx,{...o,isMultiRow:r>1,role:"tablist",ref:l},i.map(s=>Jt.default.createElement(zx,{key:s.key},s.tabs)))});Ys.displayName="Tabs";var Sn=D(L(),1);var Bx=["blur","focus"],Mx=["click","contextmenu","doubleclick","drag","dragend","dragenter","dragexit","dragleave","dragover","dragstart","drop","mousedown","mouseenter","mouseleave","mousemove","mouseout","mouseover","mouseup"];function Jc(e){return"nativeEvent"in e&&Bx.includes(e.type)}function ed(e){return"nativeEvent"in e&&Mx.includes(e.type)}var Fx={top:`top: -4px;
        left: 50%;
        transform: translate(-50%, -100%);`,bottom:`bottom: -4px;
           left: 50%;
           transform: translate(-50%, 100%);`,left:`left: -4px;
         top: 50%;
         transform: translate(-100%, -50%);`,right:`right: -4px;
          top: 50%;
          transform: translate(100%, -50%);`},jx=y.span`
  position: absolute;

  z-index: 1;
  display: ${e=>e.show?"block":"none"};
  padding: 4px;
  border: 2px solid ${({theme:e})=>e.borderDarkest};
  background: ${({theme:e})=>e.tooltip};
  box-shadow: ${Nl};
  text-align: center;
  font-size: 1rem;
  ${e=>Fx[e.position]}
`,Vx=y.div`
  position: relative;
  display: inline-block;
  white-space: nowrap;
`,Ir=(0,Sn.forwardRef)(({className:e,children:t,disableFocusListener:n=!1,disableMouseListener:r=!1,enterDelay:o=1e3,leaveDelay:l=0,onBlur:i,onClose:s,onFocus:a,onMouseEnter:c,onMouseLeave:h,onOpen:p,style:g,text:w,position:v="top",...k},R)=>{let[d,u]=(0,Sn.useState)(!1),[f,x]=(0,Sn.useState)(),[S,E]=(0,Sn.useState)(),b=!n,A=!r,B=j=>{window.clearTimeout(f),window.clearTimeout(S);let ye=window.setTimeout(()=>{u(!0),p?.(j)},o);x(ye)},I=j=>{j.persist(),Jc(j)?a?.(j):ed(j)&&c?.(j),B(j)},U=j=>{window.clearTimeout(f),window.clearTimeout(S);let ye=window.setTimeout(()=>{u(!1),s?.(j)},l);E(ye)},Z=j=>{j.persist(),Jc(j)?i?.(j):ed(j)&&h?.(j),U(j)},q=b?Z:void 0,ce=b?I:void 0,xe=A?I:void 0,Ve=A?Z:void 0,He=b?0:void 0;return Sn.default.createElement(Vx,{"data-testid":"tooltip-wrapper",onBlur:q,onFocus:ce,onMouseEnter:xe,onMouseLeave:Ve,tabIndex:He},Sn.default.createElement(jx,{className:e,"data-testid":"tooltip",position:v,ref:R,show:d,style:g,...k},w),t)});Ir.displayName="Tooltip";var Ie=D(L(),1);var td=y(bo)`
  white-space: nowrap;
`,_0=T`
  :focus {
    outline: none;
  }

  ${({$disabled:e})=>e?"cursor: default;":T`
          cursor: pointer;

          :focus {
            ${td} {
              background: ${({theme:t})=>t.hoverBackground};
              color: ${({theme:t})=>t.materialTextInvert};
              outline: 2px dotted ${({theme:t})=>t.focusSecondary};
            }
          }
        `}
`,Hx=y.ul`
  position: relative;
  isolation: isolate;

  ${({isRootLevel:e})=>e&&T`
      &:before {
        content: '';
        position: absolute;
        top: 20px;
        bottom: 0;
        left: 5.5px;
        width: 1px;
        border-left: 2px dashed ${({theme:t})=>t.borderDark};
      }
    `}

  ul {
    padding-left: 19.5px;
  }

  li {
    position: relative;

    &:before {
      content: '';
      position: absolute;
      top: 17.5px;
      left: 5.5px;
      width: 22px;
      border-top: 2px dashed ${({theme:e})=>e.borderDark};
      font-size: 12px;
    }
  }
`,Wx=y.li`
  position: relative;
  padding-left: ${({hasItems:e})=>e?"0":"13px"};

  ${({isRootLevel:e})=>e?T`
          &:last-child {
            &:after {
              content: '';
              position: absolute;
              top: 19.5px;
              left: 1px;
              bottom: 0;
              width: 10px;
              background: ${({theme:t})=>t.material};
            }
          }
        `:T`
          &:last-child {
            &:after {
              content: '';
              position: absolute;
              z-index: 1;
              top: 19.5px;
              bottom: 0;
              left: 1.5px;
              width: 10px;
              background: ${({theme:t})=>t.material};
            }
          }
        `}

  & > details > ul {
    &:after {
      content: '';
      position: absolute;
      top: -18px;
      bottom: 0;
      left: 25px;
      border-left: 2px dashed ${({theme:e})=>e.borderDark};
    }
  }
`,Ux=y.details`
  position: relative;
  z-index: 2;

  &[open] > summary:before {
    content: '-';
  }
`,Qx=y.summary`
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  color: ${({theme:e})=>e.materialText};
  user-select: none;
  padding-left: 18px;
  ${_0};

  &::-webkit-details-marker {
    display: none;
  }

  &:before {
    content: '+';
    position: absolute;
    left: 0;
    display: block;
    width: 8px;
    height: 9px;
    border: 2px solid #808080;
    padding-left: 1px;
    background-color: #fff;
    line-height: 8px;
    text-align: center;
  }
`,T0=y(So)`
  position: relative;
  z-index: 1;
  background: none;
  border: 0;
  font-family: inherit;
  padding-top: 8px;
  padding-bottom: 8px;
  margin: 0;
  ${_0};
`,Gx=y.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 6px;
`;function $0(e,t){return e.includes(t)?e.filter(n=>n!==t):[...e,t]}function R0(e){e.preventDefault()}function N0({className:e,disabled:t,expanded:n,innerRef:r,level:o,select:l,selected:i,style:s,tree:a=[]}){let c=o===0,h=(0,Ie.useCallback)(p=>{var g,w;let v=!!(p.items&&p.items.length>0),k=n.includes(p.id),R=(g=t||p.disabled)!==null&&g!==void 0?g:!1,d=R?R0:S=>l(S,p),u=R?R0:S=>l(S,p),f=i===p.id,x=Ie.default.createElement(Gx,{"aria-hidden":!0},p.icon);return Ie.default.createElement(Wx,{key:p.label,isRootLevel:c,role:"treeitem","aria-expanded":k,"aria-selected":f,hasItems:v},v?Ie.default.createElement(Ux,{open:k},Ie.default.createElement(Qx,{onClick:d,$disabled:R},Ie.default.createElement(T0,{$disabled:R},x,Ie.default.createElement(td,null,p.label))),k&&Ie.default.createElement(N0,{className:e,disabled:R,expanded:n,level:o+1,select:l,selected:i,style:s,tree:(w=p.items)!==null&&w!==void 0?w:[]})):Ie.default.createElement(T0,{as:"button",$disabled:R,onClick:u},x,Ie.default.createElement(td,null,p.label)))},[e,t,n,c,o,l,i,s]);return Ie.default.createElement(Hx,{className:c?e:void 0,style:c?s:void 0,ref:c?r:void 0,role:c?"tree":"group",isRootLevel:c},a.map(h))}function Kx({className:e,defaultExpanded:t=[],defaultSelected:n,disabled:r=!1,expanded:o,onNodeSelect:l,onNodeToggle:i,selected:s,style:a,tree:c=[]},h){let[p,g]=tt({defaultValue:t,onChange:i,onChangePropName:"onNodeToggle",value:o,valuePropName:"expanded"}),[w,v]=tt({defaultValue:n,onChange:l,onChangePropName:"onNodeSelect",value:s,valuePropName:"selected"}),k=(0,Ie.useCallback)((u,f)=>{if(i){let x=$0(p,f);i(u,x)}g(x=>$0(x,f))},[p,i,g]),R=(0,Ie.useCallback)((u,f)=>{v(f),l&&l(u,f)},[l,v]),d=(0,Ie.useCallback)((u,f)=>{u.preventDefault(),R(u,f.id),f.items&&f.items.length&&k(u,f.id)},[R,k]);return Ie.default.createElement(N0,{className:e,disabled:r,expanded:p,level:0,innerRef:h,select:d,selected:w,style:a,tree:c})}var nd=(0,Ie.forwardRef)(Kx);nd.displayName="TreeView";var m=D(rd(),1),tw=({children:e})=>(0,m.jsx)("div",{style:{position:"fixed",inset:0,background:ld.default.desktopBackground,fontFamily:"'ms_sans_serif', 'MS Sans Serif', sans-serif",fontSize:14,color:"#0a0a0a",overflow:"hidden"},children:e}),Gl=({label:e})=>(0,m.jsx)(ue,{size:"sm",square:!0,"aria-label":e,style:{fontWeight:700,lineHeight:1},children:e}),Dr=({label:e,width:t=92,children:n})=>(0,m.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:8,marginBottom:6},children:[(0,m.jsx)("span",{style:{width:t,textAlign:"right",flex:"0 0 auto"},children:e}),(0,m.jsx)("div",{style:{flex:"1 1 auto",display:"flex",alignItems:"center",gap:6},children:n})]}),en=({d:e,size:t=15,color:n="#0a0a0a",fill:r="none"})=>(0,m.jsx)("svg",{width:t,height:t,viewBox:"0 0 24 24",fill:r,stroke:n,strokeWidth:"2",style:{flex:"0 0 auto"},"aria-hidden":"true",children:e.map((o,l)=>(0,m.jsx)("path",{d:o},l))}),Zs=({bg:e,glyph:t,size:n=34,color:r="#fff"})=>(0,m.jsx)("div",{style:{width:n,height:n,background:e,display:"grid",placeItems:"center",border:"1px solid rgba(0,0,0,.35)",color:r,fontSize:Math.round(n*.42),fontWeight:700,flex:"0 0 auto",fontFamily:"'ms_sans_serif', sans-serif"},children:t}),qs=({label:e,bg:t,glyph:n})=>(0,m.jsxs)("div",{style:{textAlign:"center",color:"#fff",width:76},children:[(0,m.jsx)("div",{style:{width:36,height:36,margin:"0 auto 4px",background:t,border:"2px solid #fefefe",boxShadow:"2px 2px 0 rgba(0,0,0,.45)",display:"grid",placeItems:"center",fontSize:17,fontWeight:700},children:n}),(0,m.jsx)("span",{style:{fontSize:12,display:"block",lineHeight:1.15,textShadow:"1px 1px 0 #000"},children:e})]}),nw=jh`
  html, body, #root { height: 100%; margin: 0; }
  body { background: ${e=>e.theme.desktopBackground}; }
  * { box-sizing: border-box; }
  .pixelated, .pixelated * { -webkit-font-smoothing: none; }
`,rw=[{id:"VC-10248",cliente:"Atacad\xE3o do Sul LTDA",itens:14,total:"18.420,00",status:"Aprovado"},{id:"VC-10247",cliente:"Mercado Bom Pre\xE7o",itens:6,total:"4.190,50",status:"Pendente"},{id:"VC-10246",cliente:"Distribuidora Nova Era",itens:32,total:"51.905,00",status:"Enviado"},{id:"VC-10245",cliente:"Casa & Cia Materiais",itens:9,total:"7.312,80",status:"Aprovado"},{id:"VC-10244",cliente:"Ferragens Guarani",itens:21,total:"22.048,00",status:"Cancelado"},{id:"VC-10243",cliente:"Supermercados Pampa",itens:18,total:"16.274,30",status:"Pendente"},{id:"VC-10242",cliente:"Transportes Litoral",itens:4,total:"2.980,00",status:"Enviado"},{id:"VC-10241",cliente:"Comercial Vale Verde",itens:11,total:"9.860,00",status:"Aprovado"}],ow=()=>{let[e,t]=(0,od.useState)(0),[n,r]=(0,od.useState)("todos");return(0,m.jsxs)(Mh,{theme:ld.default,children:[(0,m.jsx)(nw,{}),(0,m.jsxs)(tw,{children:[(0,m.jsxs)("div",{className:"pixelated",style:{position:"absolute",top:10,left:8,display:"grid",gap:18},children:[(0,m.jsx)(qs,{label:"Meu computador",glyph:"\u25A3",bg:"#0a6b6b"}),(0,m.jsx)(qs,{label:"Lixeira",glyph:"\u25A4",bg:"#6b6b6b"}),(0,m.jsx)(qs,{label:"Planilhas",glyph:"\u25A6",bg:"#0a5a0a"}),(0,m.jsx)(qs,{label:"Rede",glyph:"\u25C8",bg:"#0a0a6b"})]}),(0,m.jsxs)(qn,{style:{position:"absolute",top:12,left:96,width:1150,height:995},shadow:!0,children:[(0,m.jsxs)(wn,{style:{display:"flex",alignItems:"center",gap:8},children:[(0,m.jsx)(Zs,{bg:"#060084",glyph:"VC",size:18}),(0,m.jsx)("span",{style:{fontWeight:700,flex:"1 1 auto"},children:"VendaCerta 95 \u2014 Pedidos"}),(0,m.jsx)(Gl,{label:"_"}),(0,m.jsx)(Gl,{label:"\u25A1"}),(0,m.jsx)(Gl,{label:"\u2715"})]}),(0,m.jsxs)(xn,{style:{height:"calc(100% - 40px)",padding:5,display:"flex",flexDirection:"column",gap:5},children:[(0,m.jsxs)("div",{style:{display:"flex",gap:2,alignItems:"center"},children:[["Arquivo","Editar","Ver","Pedidos","Ferramentas","Ajuda"].map(o=>(0,m.jsx)(ue,{variant:"thin",size:"sm",children:o},o)),(0,m.jsx)("div",{style:{flex:"1 1 auto"}}),(0,m.jsx)(Dl,{href:"#",onClick:o=>o.preventDefault(),style:{fontSize:12},children:"Central de ajuda"})]}),(0,m.jsx)(nt,{size:2}),(0,m.jsxs)(Nr,{style:{gap:4},children:[(0,m.jsx)(Ir,{text:"Criar novo pedido",children:(0,m.jsxs)(ue,{size:"sm",children:[(0,m.jsx)(en,{d:["M12 5v14","M5 12h14"]})," Novo"]})}),(0,m.jsx)(Ir,{text:"Salvar altera\xE7\xF5es",children:(0,m.jsxs)(ue,{size:"sm",children:[(0,m.jsx)(en,{d:["M5 4h11l3 3v13H5z","M8 4v6h7V4"]})," Salvar"]})}),(0,m.jsx)(Ir,{text:"Imprimir romaneio",children:(0,m.jsxs)(ue,{size:"sm",children:[(0,m.jsx)(en,{d:["M7 8V4h10v4","M5 8h14v7H5z","M8 15h8v5H8z"]})," Imprimir"]})}),(0,m.jsx)(nt,{orientation:"vertical",size:26}),(0,m.jsx)(Ir,{text:"Enviar por e-mail",children:(0,m.jsxs)(ue,{size:"sm",children:[(0,m.jsx)(en,{d:["M3 6h18v12H3z","M3 6l9 7 9-7"]})," Enviar"]})}),(0,m.jsx)(ue,{size:"sm",disabled:!0,children:"Excluir"})]}),(0,m.jsx)(nt,{size:2}),(0,m.jsxs)(Ys,{value:e,onChange:o=>t(o),children:[(0,m.jsxs)(lr,{value:0,children:[(0,m.jsx)(en,{d:["M4 6h16v13H4z","M8 6V4h8v2"]})," Pedidos"]}),(0,m.jsxs)(lr,{value:1,children:[(0,m.jsx)(en,{d:["M12 12a4 4 0 100-8 4 4 0 000 8","M4 21a8 8 0 0116 0"]})," Clientes"]}),(0,m.jsxs)(lr,{value:2,children:[(0,m.jsx)(en,{d:["M4 20V10","M10 20V4","M16 20v-7"]})," Relat\xF3rios"]}),(0,m.jsx)(lr,{value:3,children:"Configura\xE7\xF5es"})]}),(0,m.jsxs)(Jn,{label:"Filtros de consulta",style:{padding:"10px 8px 6px"},children:[(0,m.jsxs)("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 18px"},children:[(0,m.jsx)(Dr,{label:"Pedido",children:(0,m.jsx)(Vt,{placeholder:"VC-10248",fullWidth:!0})}),(0,m.jsx)(Dr,{label:"Cliente",children:(0,m.jsx)(_r,{value:n,onChange:o=>r(o.value),options:[{label:"Todos os clientes",value:"todos"},{label:"Atacad\xE3o do Sul LTDA",value:"atacadao"},{label:"Mercado Bom Pre\xE7o",value:"bompreco"},{label:"Distribuidora Nova Era",value:"novaera"}],width:"100%"})}),(0,m.jsx)(Dr,{label:"De",children:(0,m.jsx)(Vt,{defaultValue:"01/10/2026",fullWidth:!0})}),(0,m.jsx)(Dr,{label:"At\xE9",children:(0,m.jsx)(Vt,{defaultValue:"21/10/2026",fullWidth:!0})})]}),(0,m.jsx)(nt,{size:2,style:{margin:"2px 0 8px"}}),(0,m.jsxs)("div",{style:{display:"flex",gap:26,alignItems:"flex-start"},children:[(0,m.jsxs)("div",{children:[(0,m.jsx)("div",{style:{marginBottom:4,fontWeight:700},children:"Canal de venda"}),(0,m.jsx)(Yn,{checked:!0,label:"Loja online"}),(0,m.jsx)(Yn,{checked:!0,label:"Balc\xE3o"}),(0,m.jsx)(Yn,{label:"Telefone"})]}),(0,m.jsxs)("div",{children:[(0,m.jsx)("div",{style:{marginBottom:4,fontWeight:700},children:"Ordenar por"}),(0,m.jsx)(Eo,{checked:!0,name:"ordem",value:"recente",label:"Mais recentes"}),(0,m.jsx)(Eo,{name:"ordem",value:"valor",label:"Maior valor"}),(0,m.jsx)(Eo,{name:"ordem",value:"prazo",label:"Prazo de entrega"})]}),(0,m.jsxs)("div",{style:{marginLeft:"auto",display:"flex",flexDirection:"column",gap:6},children:[(0,m.jsx)(ue,{primary:!0,size:"sm",style:{minWidth:108},children:"Filtrar"}),(0,m.jsx)(ue,{size:"sm",style:{minWidth:108},children:"Limpar"}),(0,m.jsx)(ue,{size:"sm",style:{minWidth:108},children:"Salvar como\u2026"})]})]})]}),(0,m.jsxs)(Ql,{style:{flex:"1 1 auto",minHeight:0,overflow:"auto",padding:0},children:[(0,m.jsxs)(Ul,{children:[(0,m.jsx)(To,{children:(0,m.jsxs)(or,{children:[(0,m.jsx)(ot,{style:{width:118},children:"Pedido"}),(0,m.jsx)(ot,{children:"Cliente"}),(0,m.jsx)(ot,{style:{textAlign:"right",width:68},children:"Itens"}),(0,m.jsx)(ot,{style:{textAlign:"right",width:126},children:"Total (R$)"}),(0,m.jsx)(ot,{style:{width:104},children:"Status"}),(0,m.jsx)(ot,{style:{width:84},children:"Entrega"})]})}),(0,m.jsx)(Co,{children:rw.map(o=>(0,m.jsxs)(or,{style:{cursor:"default"},children:[(0,m.jsx)(rt,{children:(0,m.jsx)(Dl,{href:"#",onClick:l=>l.preventDefault(),children:o.id})}),(0,m.jsx)(rt,{children:o.cliente}),(0,m.jsx)(rt,{style:{textAlign:"right"},children:o.itens}),(0,m.jsx)(rt,{style:{textAlign:"right"},children:o.total}),(0,m.jsx)(rt,{children:o.status}),(0,m.jsx)(rt,{children:o.status==="Cancelado"?"\u2014":"23/10"})]},o.id))})]}),(0,m.jsxs)(Jn,{label:"Itens do pedido VC-10246",style:{margin:"6px 4px 4px",padding:"10px 8px 6px"},children:[(0,m.jsxs)(Ul,{children:[(0,m.jsx)(To,{children:(0,m.jsxs)(or,{children:[(0,m.jsx)(ot,{style:{width:110},children:"SKU"}),(0,m.jsx)(ot,{children:"Produto"}),(0,m.jsx)(ot,{style:{textAlign:"right",width:80},children:"Qtd."}),(0,m.jsx)(ot,{style:{textAlign:"right",width:120},children:"Unit\xE1rio"}),(0,m.jsx)(ot,{style:{textAlign:"right",width:130},children:"Subtotal"})]})}),(0,m.jsx)(Co,{children:[["SKU-8841","Cabo flex\xEDvel 2,5 mm \u2014 rolo 100 m",12,"1.180,00","14.160,00"],["SKU-2210","Disjuntor tripolar 63 A",8,"742,50","5.940,00"],["SKU-1073","Quadro de distribui\xE7\xE3o 24 disj.",6,"2.035,00","12.210,00"],["SKU-6602","Canaleta PVC 40x20 \u2014 barra 3 m",40,"34,90","1.396,00"]].map(([o,l,i,s,a])=>(0,m.jsxs)(or,{children:[(0,m.jsx)(rt,{children:o}),(0,m.jsx)(rt,{children:l}),(0,m.jsx)(rt,{style:{textAlign:"right"},children:i}),(0,m.jsx)(rt,{style:{textAlign:"right"},children:s}),(0,m.jsx)(rt,{style:{textAlign:"right"},children:a})]},o))})]}),(0,m.jsxs)("div",{style:{display:"flex",justifyContent:"flex-end",gap:24,padding:"6px 8px 2px",fontSize:13},children:[(0,m.jsxs)("span",{children:["Frete: ",(0,m.jsx)("strong",{children:"R$ 1.280,00"})]}),(0,m.jsxs)("span",{children:["Impostos: ",(0,m.jsx)("strong",{children:"R$ 6.919,00"})]}),(0,m.jsxs)("span",{children:["Total: ",(0,m.jsx)("strong",{children:"R$ 51.905,00"})]})]})]})]}),(0,m.jsxs)(xt,{variant:"status",style:{display:"flex",alignItems:"center",gap:8,padding:"3px 6px",fontSize:12},children:[(0,m.jsx)(xt,{variant:"field",style:{padding:"1px 6px"},children:"8 de 128 pedidos"}),(0,m.jsx)(xt,{variant:"field",style:{padding:"1px 6px"},children:"Total: R$ 132.990,60"}),(0,m.jsx)("div",{style:{flex:"1 1 auto"}}),(0,m.jsx)(xt,{variant:"field",style:{padding:"1px 6px"},children:"CAPS"}),(0,m.jsx)(xt,{variant:"field",style:{padding:"1px 6px"},children:"NUM"}),(0,m.jsx)(xt,{variant:"field",style:{padding:"1px 6px"},children:"Sincronizado \xE0s 14:32"})]})]})]}),(0,m.jsxs)(qn,{style:{position:"absolute",top:12,left:1262,width:638,height:500},shadow:!0,children:[(0,m.jsxs)(wn,{style:{display:"flex",alignItems:"center",gap:8},children:[(0,m.jsx)(Zs,{bg:"#0a6b6b",glyph:"\u03A3",size:18}),(0,m.jsx)("span",{style:{fontWeight:700,flex:"1 1 auto"},children:"Resumo do per\xEDodo"}),(0,m.jsx)(Gl,{label:"\u2715"})]}),(0,m.jsxs)(xn,{style:{height:"calc(100% - 40px)",padding:8,display:"flex",flexDirection:"column",gap:8},children:[(0,m.jsxs)(Jn,{label:"Indicadores",style:{padding:"10px 10px 8px"},children:[[["Receita do m\xEAs","R$ 1.284.930,00"],["Pedidos pagos","1.842"],["Ticket m\xE9dio","R$ 697,57"]].map(([o,l])=>(0,m.jsxs)("div",{style:{display:"flex",justifyContent:"space-between",marginBottom:6},children:[(0,m.jsx)("span",{children:o}),(0,m.jsx)("strong",{children:l})]},o)),(0,m.jsx)(nt,{size:2,style:{margin:"6px 0"}}),(0,m.jsxs)("div",{style:{display:"flex",justifyContent:"space-between",marginBottom:4},children:[(0,m.jsx)("span",{children:"Meta do m\xEAs"}),(0,m.jsx)("span",{children:"78%"})]}),(0,m.jsx)(Vl,{value:78,hideValue:!0}),(0,m.jsx)("small",{style:{display:"block",marginTop:6,color:"#333"},children:"Faltam R$ 322.070,00 para a meta."})]}),(0,m.jsx)(Jn,{label:"A\xE7\xF5es r\xE1pidas",style:{padding:2},children:(0,m.jsxs)(wo,{fullWidth:!0,style:{border:0},children:[(0,m.jsxs)(ft,{style:{display:"flex",gap:8,alignItems:"center",justifyContent:"flex-start"},children:[(0,m.jsx)(en,{d:["M4 6h16v13H4z"]})," Abrir ordem de servi\xE7o"]}),(0,m.jsxs)(ft,{style:{display:"flex",gap:8,alignItems:"center",justifyContent:"flex-start"},children:[(0,m.jsx)(en,{d:["M12 3v12","M7 10l5 5 5-5","M4 21h16"]})," Exportar planilha"]}),(0,m.jsxs)(ft,{style:{display:"flex",gap:8,alignItems:"center",justifyContent:"flex-start"},children:[(0,m.jsx)(en,{d:["M5 8h14v9H5z","M8 8V5h8v3"]})," Gerar boleto"]})]})}),(0,m.jsxs)(xt,{variant:"field",style:{padding:8,flex:"1 1 auto"},children:[(0,m.jsx)("div",{style:{fontWeight:700,marginBottom:4},children:"Alertas do sistema"}),(0,m.jsxs)("div",{style:{fontSize:12,lineHeight:1.5},children:["4 pedidos acima do SLA de 24h. 2 boletos vencem hoje.",(0,m.jsx)("br",{}),"Estoque cr\xEDtico: 3 SKUs. Backup conclu\xEDdo \xE0s 03:00."]})]})]})]}),(0,m.jsxs)(qn,{style:{position:"absolute",top:528,left:1262,width:638,height:474,zIndex:20},shadow:!0,children:[(0,m.jsxs)(wn,{active:!0,style:{display:"flex",alignItems:"center",gap:8},children:[(0,m.jsx)("span",{style:{flex:"1 1 auto",fontWeight:700},children:"Confirmar envio \u2014 VC-10246"}),(0,m.jsx)(Gl,{label:"\u2715"})]}),(0,m.jsxs)(xn,{style:{height:"calc(100% - 40px)",padding:12,display:"flex",flexDirection:"column"},children:[(0,m.jsxs)("div",{style:{display:"flex",gap:10,marginBottom:12},children:[(0,m.jsx)("div",{style:{width:34,height:34,borderRadius:"50%",background:"#060084",color:"#fefefe",display:"grid",placeItems:"center",fontWeight:700,flex:"0 0 auto",fontSize:18},children:"?"}),(0,m.jsxs)("div",{style:{fontSize:13,lineHeight:1.45},children:["Confirmar o envio de ",(0,m.jsx)("strong",{children:"VC-10246"})," \u2014 Distribuidora Nova Era, 32 itens, pela transportadora selecionada?"]})]}),(0,m.jsx)(Dr,{label:"Transportadora",width:104,children:(0,m.jsx)(_r,{value:"loggi",options:[{label:"Loggi \u2014 Expresso (1 dia \xFAtil)",value:"loggi"},{label:"Total Express \u2014 Rodovi\xE1rio",value:"total"},{label:"Correios \u2014 PAC",value:"pac"}],width:"100%"})}),(0,m.jsx)(Dr,{label:"Volumes",width:104,children:(0,m.jsx)(Vt,{defaultValue:"4",style:{width:70}})}),(0,m.jsx)(Dr,{label:"Nota fiscal",width:104,children:(0,m.jsx)(Vt,{defaultValue:"3526 1021 0001 4800 0980",fullWidth:!0})}),(0,m.jsx)(nt,{size:2,style:{margin:"6px 0 10px"}}),(0,m.jsx)(Yn,{checked:!0,label:"Contratar seguro de carga (R$ 84,20)"}),(0,m.jsx)(Yn,{label:"Enviar romaneio ao cliente por e-mail"}),(0,m.jsx)("div",{style:{flex:"1 1 auto"}}),(0,m.jsxs)("div",{style:{display:"flex",justifyContent:"flex-end",gap:8},children:[(0,m.jsx)(ue,{size:"sm",style:{minWidth:104},children:"Cancelar"}),(0,m.jsx)(ue,{primary:!0,size:"sm",style:{minWidth:136},children:"Confirmar envio"})]})]})]}),(0,m.jsx)("div",{style:{position:"absolute",top:46,left:262,zIndex:40,width:258},children:(0,m.jsxs)(wo,{fullWidth:!0,style:{padding:2,boxShadow:"2px 2px 0 rgba(0,0,0,.45)",position:"relative"},children:[(0,m.jsxs)(ft,{children:[(0,m.jsx)("span",{style:{fontWeight:700},children:"Novo pedido"}),(0,m.jsx)("span",{style:{float:"right",color:"#555"},children:"Ctrl+N"})]}),(0,m.jsx)(ft,{children:"Abrir pedido existente\u2026"}),(0,m.jsx)(ft,{children:"Duplicar pedido"}),(0,m.jsx)(nt,{size:2,style:{margin:"3px 0"}}),(0,m.jsx)(ft,{children:"Exportar planilha"}),(0,m.jsx)(ft,{children:"Imprimir romaneio"}),(0,m.jsx)(nt,{size:2,style:{margin:"3px 0"}}),(0,m.jsx)(ft,{children:"Fechar janela"})]})}),(0,m.jsxs)(xt,{style:{position:"absolute",bottom:0,left:0,right:0,height:44,zIndex:50,display:"flex",alignItems:"center",gap:4,padding:"3px 4px"},children:[(0,m.jsxs)(ue,{primary:!0,active:!0,style:{height:34,minWidth:88,fontWeight:700},children:[(0,m.jsx)("span",{style:{marginRight:6},children:"\u25A3"}),"Iniciar"]}),(0,m.jsx)(nt,{orientation:"vertical",size:30}),(0,m.jsxs)(ue,{size:"sm",active:!0,style:{height:34,minWidth:214,justifyContent:"flex-start"},children:[(0,m.jsx)(Zs,{bg:"#060084",glyph:"VC",size:16}),(0,m.jsx)("span",{style:{marginLeft:6,fontWeight:700},children:"VendaCerta 95"})]}),(0,m.jsxs)(ue,{size:"sm",style:{height:34,minWidth:150,justifyContent:"flex-start"},children:[(0,m.jsx)(Zs,{bg:"#0a6b6b",glyph:"\u03A3",size:16}),(0,m.jsx)("span",{style:{marginLeft:6},children:"Resumo"})]}),(0,m.jsx)(ue,{size:"sm",style:{height:34,minWidth:132,justifyContent:"flex-start"},children:"Explorer"}),(0,m.jsx)("div",{style:{flex:"1 1 auto"}}),(0,m.jsxs)(xt,{variant:"field",style:{height:30,display:"flex",alignItems:"center",gap:14,padding:"0 10px",fontSize:12},children:[(0,m.jsx)("span",{children:"\u25AE\u25AE\u25AE"}),(0,m.jsx)("span",{children:"\u2328 PT-BR"}),(0,m.jsx)("span",{children:"14:32"})]})]})]})]})};(0,L0.createRoot)(document.getElementById("root")).render((0,m.jsx)(ow,{}));})();
