import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const validOrigins=new Set(["https://lookphone-ar.github.io","https://ivanramat-lookphone.github.io"]);
const json=(body:unknown,status=200,origin:string|null=null)=>new Response(JSON.stringify(body),{
 status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",
 ...(origin&&validOrigins.has(origin)?{"Access-Control-Allow-Origin":origin}:{}),
 "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info,prefer",
 "Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}
});
function generatedPassword(){
 const abc="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
 const bytes=crypto.getRandomValues(new Uint8Array(18));
 return Array.from(bytes,b=>abc[b%abc.length]).join("");
}
Deno.serve(async(req:Request)=>{
 const origin=req.headers.get("Origin");
 if(origin&&!validOrigins.has(origin))return json({error:"Origen no permitido"},403,origin);
 if(req.method==="OPTIONS")return json({ok:true},200,origin);
 if(req.method!=="POST")return json({error:"Método no permitido"},405,origin);
 const base=Deno.env.get("SUPABASE_URL"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
       anon=Deno.env.get("SUPABASE_ANON_KEY");
 if(!base||!service||!anon)return json({error:"Servicio no configurado"},503,origin);
 const auth=req.headers.get("Authorization")||"";
 if(!auth.startsWith("Bearer "))return json({error:"Iniciá sesión"},401,origin);
 const userResponse=await fetch(base+"/auth/v1/user",{headers:{apikey:anon,Authorization:auth}});
 if(!userResponse.ok)return json({error:"Tu sesión no es válida"},401,origin);
 const user=await userResponse.json().catch(()=>null);
 if(!user?.id)return json({error:"Sesión inválida"},401,origin);
 const statusResponse=await fetch(base+"/rest/v1/rpc/nfc_platform_access_status",{
 method:"POST",headers:{apikey:anon,Authorization:auth,"Content-Type":"application/json"},body:"{}"});
 if(!statusResponse.ok)return json({error:"No se pudo comprobar el comercio"},403,origin);
 const account=await statusResponse.json().catch(()=>null);
 if(!account?.enabled||account?.is_staff)return json({error:"Solo el dueño de un comercio activo puede gestionar empleados"},403,origin);

 let payload:any;
 try{payload=await req.json()}catch{return json({error:"Datos inválidos"},400,origin);}
 const action=String(payload?.action||"create");
 const svcHeaders={apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"};
 const rpc=async(name:string,body:unknown)=>{
  const response=await fetch(base+"/rest/v1/rpc/"+name,{method:"POST",headers:svcHeaders,body:JSON.stringify(body)});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.message||"No se pudo completar la gestión del empleado");
  return data;
 };
 try{
  if(action==="create"){
   const username=String(payload?.username||"").trim().toLowerCase();
   const displayName=String(payload?.name||"").trim();
   if(!/^[a-z][a-z0-9_]{3,23}$/.test(username))return json({error:"Usuario: entre 4 y 24 caracteres, empezando con letra y usando solo letras, números o guion bajo"},400,origin);
   if(displayName.length<2||displayName.length>80)return json({error:"Escribí el nombre del empleado (2 a 80 caracteres)"},400,origin);
   const email="staff-"+username+"@lookphone-ar.github.io";
   const password=generatedPassword();
   const created=await fetch(base+"/auth/v1/admin/users",{
    method:"POST",headers:svcHeaders,
    body:JSON.stringify({email,password,email_confirm:true,app_metadata:{look_role:"staff"}})});
   const newUser=await created.json().catch(()=>null);
   if(!created.ok||!newUser?.id){
    if(created.status===422||created.status===409)return json({error:"Ese usuario ya existe. Elegí otro nombre de usuario."},409,origin);
    return json({error:"No se pudo crear la cuenta del empleado"},502,origin);
   }
   try{
    await rpc("nfc_staff_create_direct",{p_owner:user.id,p_user:newUser.id,p_username:username,p_name:displayName});
   }catch(err){
    // A failed binding must not leave an employee account with an orphan trial.
    const remove=await fetch(base+"/auth/v1/admin/users/"+encodeURIComponent(newUser.id),{method:"DELETE",headers:svcHeaders});
    if(!remove.ok)console.error("Failed to clean up orphan staff account");
    throw err;
   }
   return json({created:true,username,name:displayName,temporary_password:password},200,origin);
  }
  if(action==="reset_password"){
    const id=String(payload?.member_id||"");
    if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:"Empleado inválido"},400,origin);
    const memberUserId=await rpc("nfc_staff_owned_identity",{p_owner:user.id,p_member:id});
    if(typeof memberUserId!=="string")return json({error:"No se encontró un empleado habilitado"},404,origin);
    const password=generatedPassword();
    const changed=await fetch(base+"/auth/v1/admin/users/"+encodeURIComponent(memberUserId),{
     method:"PUT",headers:svcHeaders,body:JSON.stringify({password})});
    if(!changed.ok)return json({error:"No se pudo actualizar la contraseña"},502,origin);
    return json({reset:true,temporary_password:password},200,origin);
  }
  return json({error:"Operación desconocida"},400,origin);
 }catch(err){
  console.error("Staff management failed",err instanceof Error?err.message:"Unknown failure");
  return json({error:"No se pudo completar la operación. Revisá que el usuario no esté repetido y el comercio esté activo."},422,origin);
 }
});