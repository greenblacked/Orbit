(function(){var t=null;try{t=localStorage.getItem("theme")}catch(e){}
var h=new Date().getHours();
var theme=t==="reactor"?"reactor":t==="night"||(t!=="day"&&(h>=20||h<6))?"night":"day";
document.documentElement.setAttribute("data-theme",theme);
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",{day:"#f4f1ea",night:"#000000",reactor:"#070807"}[theme]);})();
