(function(){var t=null,w=window,h=new Date().getHours();try{t=localStorage.getItem("theme")}catch(e){}
var theme=t==="reactor"||t==="night"||t==="day"?t:(w.matchMedia?w.matchMedia("(prefers-color-scheme: dark)").matches:h>=20||h<6)?"night":"day";
document.documentElement.setAttribute("data-theme",theme);
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",{day:"#f4f1ea",night:"#000000",reactor:"#070807"}[theme]);})();
