import "jsr:@supabase/functions-js/edge-runtime.d.ts";
type Data=Record<string,any>;
const origins=new Set(["https://lookphone-ar.github.io","https://ivanramat-lookphone.github.io"]);
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const newSecret=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
async function sha(s:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));}
async function pinHash(pin:string,salt:string){
 const raw=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
 const out=await crypto.subtle.deriveBits({name:"PBKDF2",salt:Uint8Array.from(salt.match(/.{2}/g)!.map(x=>parseInt(x,16))),iterations:180000,hash:"SHA-256"},raw,256);
 return hex(new Uint8Array(out));
}
const uuid=(s:unknown)=>typeof s==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("origin");
 const cors={"Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin",
 ...(origin&&origins.has(origin)?{"Access-Control-Allow-Origin":origin}:{}),
 "Access-Control-Allow-Headers":"apikey,authorization,content-type,x-client-info,prefer,x-look-staff-token",
 "Access-Control-Allow-Methods":"POST,OPTIONS"};
 const ret=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
 if(origin&&!origins.has(origin))return ret({error:"Origen no autorizado"},403);
 if(req.method==="OPTIONS")return ret({ok:true});
 if(req.method!=="POST")return ret({error:"Solo POST"},405);
 const base=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),anon=Deno.env.get("SUPABASE_ANON_KEY");
 if(!base||!service||!anon)return ret({error:"Servidor sin configurar"},503);
 const serviceHeaders={apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"};
 const db=async(path:string,opts:Data={})=>{
  const response=await fetch(base+"/rest/v1/"+path,{...opts,headers:{...serviceHeaders,...(opts.headers||{})}});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.message||"No se pudo completar la operación");
  return data;
 };
 const rpc=(name:string,args:Data)=>db("rpc/"+name,{method:"POST",body:JSON.stringify(args)});
 const body=await req.json().catch(()=>null);
 if(!body||typeof body!=="object")return ret({error:"Solicitud inválida"},400);
 const action=String(body.action||"");
 try {
  const authorizedOwner=async()=>{
    const auth=req.headers.get("Authorization")||"";
    if(!auth.startsWith("Bearer "))throw new Error("Iniciá sesión como dueño del comercio");
    const response=await fetch(base+"/auth/v1/user",{headers:{apikey:anon,Authorization:auth}});
    if(!response.ok)throw new Error("Sesión comercial inválida");
    const user=await response.json();if(!uuid(user?.id))throw new Error("Cuenta inválida");
    const enabled=await rpc("nfc_employee_owner_ok",{p_owner:user.id});
    if(enabled!==true)throw new Error("Tu comercio no está habilitado");
    return user.id as string;
  };
  const ownerProfile=async(owner:string)=>{
    const list=await db("nfc_profiles?owner_id=eq."+owner+"&select=id,business,active&order=created_at.asc&limit=1");
    if(!list?.[0]?.id||!list[0].active)throw new Error("Primero activá tu negocio");
    return list[0];
  };
  if(action.startsWith("owner_")){
    const owner=await authorizedOwner();
    const p=await ownerProfile(owner);
    if(action==="owner_list"){
      const rows=await db("nfc_employee_profiles?owner_id=eq."+owner+"&select=id,name,active,created_at&order=created_at.asc&limit=30");
      return ret({staff:rows,profile_id:p.id});
    }
    if(action==="owner_create"){
      const name=String(body.name||"").trim(),pin=String(body.pin||"");
      if(name.length<2||name.length>80||!/^[0-9]{6}$/.test(pin))return ret({error:"Escribí un nombre y un PIN de 6 números"},400);
      const others=await db("nfc_employee_profiles?owner_id=eq."+owner+"&select=id,active,name&limit=40");
      if(others.some((x:Data)=>x.name.toLowerCase()===name.toLowerCase()))return ret({error:"Ya existe un empleado con ese nombre"},409);
      if(others.filter((x:Data)=>x.active).length>=10)return ret({error:"El máximo es 10 empleados activos"},400);
      const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash=await pinHash(pin,salt);
      const rows=await db("nfc_employee_profiles",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({owner_id:owner,profile_id:p.id,name,pin_salt:salt,pin_hash:hash})});
      return ret({created:true,employee:{id:rows[0].id,name:rows[0].name,active:true}});
    }
    if(action==="owner_update"){
      if(!uuid(body.id))return ret({error:"Empleado inválido"},400);
      const existing=await db("nfc_employee_profiles?id=eq."+body.id+"&owner_id=eq."+owner+"&select=id,active&limit=1");
      if(!existing.length)return ret({error:"Empleado no encontrado"},404);
      const mode=String(body.mode||"");
      let fields:Data={};
      if(mode==="deactivate")fields={active:false};
      else if(mode==="activate"){
        const active=await db("nfc_employee_profiles?owner_id=eq."+owner+"&active=eq.true&select=id&limit=15");
        if(active.length>=10)return ret({error:"Máximo de 10 empleados"},400);
        fields={active:true,failed_attempts:0,locked_until:null};
      }else if(mode==="reset_pin"){
        const pin=String(body.pin||"");
        if(!/^[0-9]{6}$/.test(pin))return ret({error:"El PIN debe tener 6 dígitos"},400);
        const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
        fields={pin_salt:salt,pin_hash:await pinHash(pin,salt),failed_attempts:0,locked_until:null};
      }else return ret({error:"Operación inválida"},400);
      await db("nfc_employee_profiles?id=eq."+body.id+"&owner_id=eq."+owner,
        {method:"PATCH",body:JSON.stringify(fields),headers:{Prefer:"return=minimal"}});
      await db("nfc_employee_sessions?employee_id=eq."+body.id,{method:"DELETE"});
      return ret({updated:true});
    }
    return ret({error:"Acción desconocida"},400);
  }
  if(action==="roster"){
    if(!uuid(body.profile_id))return ret({error:"Comercio inválido"},400);
    const p=await db("nfc_profiles?id=eq."+body.profile_id+"&active=eq.true&select=id,business,owner_id&limit=1");
    if(!p.length||!(await rpc("nfc_employee_owner_ok",{p_owner:p[0].owner_id})))return ret({error:"Comercio no disponible"},404);
    const list=await db("nfc_employee_profiles?profile_id=eq."+p[0].id+"&active=eq.true&select=id,name&order=name.asc&limit=20");
    return ret({business:p[0].business,employees:list});
  }
  if(action==="login"){
    if(!uuid(body.employee_id)||!uuid(body.profile_id)||!/^[0-9]{6}$/.test(String(body.pin||"")))return ret({error:"Seleccioná un empleado y escribí su PIN de 6 números"},400);
    const rows=await db("nfc_employee_profiles?id=eq."+body.employee_id+"&profile_id=eq."+body.profile_id+"&active=eq.true&select=id,name,pin_salt,pin_hash,locked_until,owner_id&limit=1");
    if(!rows.length||!(await rpc("nfc_employee_owner_ok",{p_owner:rows[0].owner_id})))return ret({error:"PIN o empleado incorrectos"},401);
    const employee=rows[0];
    if(employee.locked_until&&Date.parse(employee.locked_until)>Date.now())return ret({error:"Acceso temporalmente bloqueado; probá más tarde"},429);
    const expected=await pinHash(String(body.pin),employee.pin_salt);
    const equal=expected===employee.pin_hash;const token=newSecret(),token_hash=await sha(token);
    const success=await rpc("nfc_employee_login_finish",{p_employee:employee.id,p_good:equal,p_token_hash:equal?token_hash:null});
    if(success!==true)return ret({error:"PIN o empleado incorrectos"},401);
    return ret({authenticated:true,token,name:employee.name,expires_in_hours:8});
  }
  const staffToken=req.headers.get("x-look-staff-token")||"";
  if(!/^[a-f0-9]{64}$/.test(staffToken))return ret({error:"Abrí tu perfil de empleado e ingresá el PIN"},401);
  const hash=await sha(staffToken);
  const sessions=await db("nfc_employee_sessions?token_hash=eq."+hash+"&expires_at=gt."+encodeURIComponent(new Date().toISOString())+"&select=employee_id&limit=1");
  if(!sessions.length)return ret({error:"Sesión vencida, ingresá otra vez el PIN"},401);
  const rows=await db("nfc_employee_profiles?id=eq."+sessions[0].employee_id+"&active=eq.true&select=id,name,profile_id,owner_id&limit=1");
  if(!rows.length||!(await rpc("nfc_employee_owner_ok",{p_owner:rows[0].owner_id})))return ret({error:"Acceso sin permiso"},403);
  const employee=rows[0];
  if(action==="whoami")return ret({authenticated:true,name:employee.name,profile_id:employee.profile_id});
  if(action==="logout"){
    await db("nfc_employee_sessions?token_hash=eq."+hash,{method:"DELETE"});
    return ret({ok:true});
  }
  if(action==="search"){
    const needle=String(body.query||"").trim().slice(0,60).replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g,"");
    const search=needle?"&or="+encodeURIComponent("(name.ilike.*"+needle+"*,phone.ilike.*"+needle+"*)"):"";
    const rows=await db("nfc_clients?profile_id=eq."+employee.profile_id+search+"&select=id,name,phone,points,visits&order=name.asc&limit=40");
    const prof=await db("nfc_profiles?id=eq."+employee.profile_id+"&select=goal,reward&limit=1");
    return ret({clients:rows.map((c:Data)=>({...c,goal:prof[0].goal,reward:prof[0].reward}))});
  }
  if(action==="record"){
    if(!uuid(body.client_id)||!uuid(body.event)||!["visit","redeem"].includes(body.kind))
       return ret({error:"Movimiento inválido"},400);
    const amount=body.amount===null||body.amount===undefined?null:Number(body.amount);
    if(amount!==null&&(!Number.isFinite(amount)||amount<0||amount>9999999999.99))
       return ret({error:"Monto de compra inválido"},400);
    const res=await rpc("nfc_employee_record",{p_employee:employee.id,p_client:body.client_id,
      p_kind:body.kind,p_event:body.event,p_sale_amount:body.kind==="visit"?amount:null});
    return ret({recorded:true,result:res});
  }
  return ret({error:"Operación no permitida"},400);
 }catch(err){
  console.error("LOOK employee API failed",err instanceof Error?err.message:"unknown");
  return ret({error:err instanceof Error?err.message:"No se pudo completar la operación"},400);
 }
});