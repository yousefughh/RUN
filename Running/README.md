# RUNMATE setup

## الملفات
- `index.html`: واجهة الموقع.
- `styles.css`: التنسيق والتجاوب مع الهاتف.
- `app.js`: تسجيل الدخول والحجوزات والجريات والمحادثات.
- `schema.sql`: الجداول وصلاحيات قاعدة البيانات.

## 1) إعداد Supabase
1. أنشئ مشروعًا في https://supabase.com/
2. افتح SQL Editor والصق محتوى `schema.sql` كاملًا ثم نفّذه.
3. من Project Settings > API انسخ Project URL و anon/public key.
4. افتح `app.js` وبدّل:
   - `YOUR_SUPABASE_PROJECT_URL`
   - `YOUR_SUPABASE_ANON_KEY`
   بالقيم الخاصة بمشروعك. لا تستخدم `service_role` key في الواجهة مطلقًا.
5. من Authentication > Providers فعّل Email. إذا أردت الهاتف، فعّل Phone واضبط مزوّد SMS؛ قد تكون رسائل SMS مدفوعة.
6. من Authentication > URL Configuration أضف عنوان الموقع إلى Site URL وRedirect URLs.

## 2) جعل حسابك أدمن
1. أنشئ حسابك من الموقع أولًا.
2. افتح Supabase > Authentication > Users وخذ UUID الخاص بحسابك.
3. في SQL Editor نفّذ (استبدل UUID بالقيمة الحقيقية):
   `update public.profiles set role = 'admin' where id = 'YOUR_AUTH_USER_UUID';`
4. سجّل الخروج ثم الدخول من جديد. لن يكون أي حساب جديد أدمن تلقائيًا.

## 3) التشغيل
شغّل المشروع عبر VS Code Live Server أو استضافة ثابتة تدعم HTTPS.

## ملاحظات مهمة
- الجريات التجريبية القديمة حُذفت؛ لن تظهر جريات إلا بعد أن ينشئ الأدمن جَرية.
- سياسات قاعدة البيانات تمنع الأعضاء من إنشاء/تعديل الجريات، وتمنع الكتابة في محادثة القراءة فقط لغير الأدمن.
- الحجز الحالي ينشئ سجل مشاركة. إذا أردت ضمان عدم تجاوز عدد المقاعد عند ضغط عدة مستخدمين في نفس اللحظة، نحتاج إضافة RPC/transaction مخصصة للحجز.
- هذه نسخة بداية متكاملة وظيفيًا، ويجب اختبار إعدادات Auth وRLS في مشروعك قبل نشرها للعامة.
