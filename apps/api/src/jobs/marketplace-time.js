export function zonedCalendarInstant(date,timeZone){
  const [year,month,day]=String(date).split('-').map(Number);
  const probe=new Date(Date.UTC(year,month-1,day,12));
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(probe).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  const offset=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second)-probe.getTime();
  return new Date(Date.UTC(year,month-1,day)-offset).toISOString();
}

export function marketplaceLocalDate(instant,timeZone){
  return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));
}
