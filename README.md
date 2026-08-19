# Lịch Trình

Tiện ích mở rộng cho [SillyTavern](https://github.com/SillyTavern/SillyTavern) giúp bạn phác họa và
theo dõi câu chuyện nhập vai của mình: dòng thời gian, lịch trình nhân vật, phục bút, đại cương,
lịch lễ tết, ngoại truyện và tủ lưu những khoảnh khắc đáng nhớ.

Đây là **bản Việt hóa** của [`atonal519/ST-SevenDaysCal`](https://github.com/atonal519/ST-SevenDaysCal)
(构画), phiên bản 3.3.0 — dịch đầy đủ giao diện, lời nhắc gửi cho AI và chú thích mã nguồn.

---

## Bảy module

Tiện ích được tổ chức theo một hệ hình học: **Điểm · Trục · Tuyến · Diện · Gian · Lăng · Tọa Độ**.
Mỗi module là một tab ở thanh bên trái.

| Module | Là gì | Dùng khi nào |
| --- | --- | --- |
| **Điểm** (lịch trình) | Thẻ việc cần làm và trạng thái gần đây theo góc nhìn Tôi hoặc Người ấy. AI đọc cốt truyện rồi suy ra ai đang làm gì, sắp có lịch gì, tâm trạng và vị trí. | Muốn nắm nhanh «bây giờ ai đang ở đâu, sắp làm gì». |
| **Trục** (dòng thời gian) | Lịch pháp của thế giới: lễ tết, sinh nhật, ngày kỷ niệm, lịch tháng, và **thước đo** (sổ ngầm) theo dõi trạng thái đổi theo ngày. | Muốn cốt truyện hô ứng với lịch và với những gì đang diễn biến theo thời gian. |
| **Tuyến** (tuyến sự kiện) | Theo dõi phục bút và mạch ngầm — những nút thắt đã gieo mà chưa thu lại. Tự tiến theo nhịp bạn đặt. | Kể chuyện dài hơi, sợ quên mất phục bút đã cài. |
| **Diện** (đại cương) | Bảng nhịp của cả câu chuyện, chia thành 6–8 nút, đánh dấu «đang diễn tới đâu, bước kế đi đâu». | Muốn câu chuyện có xương sống, không lạc đề. |
| **Gian** (trò chuyện ngoài lề) | Không gian nói chuyện với AI ngoài vai diễn: bàn cốt truyện, thiết định, quan hệ, lịch pháp. Không lọt vào cuộc trò chuyện chính. | Cần bàn riêng với «đạo diễn». |
| **Lăng** (tiểu kịch trường) | Cho AI viết một truyện ngắn / ngoại truyện độc lập dựa trên bối cảnh hiện tại, có làm đẹp bố cục. | Muốn xem «nếu… thì sao». |
| **Tọa Độ** (tầng đã lưu) | Lưu bản chụp nguyên vẹn một tầng tin nhắn (kèm kiểu dáng lúc đó), phân loại theo nhân vật / cuộc trò chuyện / nhãn. | Đánh dấu cảnh kinh điển để đọc lại. |

---

## Cài đặt

1. Trong SillyTavern, mở **Extensions** → **Install extension**.
2. Dán địa chỉ repo này rồi cài.

Hoặc cài tay: sao chép cả thư mục vào
`SillyTavern/public/scripts/extensions/third-party/Lich-Trinh/` rồi tải lại trang.

### Mở bảng bằng cách nào

Có hai lối vào, dùng lối nào cũng được:

1. **Menu đũa phép** (biểu tượng ✨ cạnh ô nhập tin nhắn) → chọn **Lịch Trình**. Đây là lối vào luôn
   luôn có, dùng khi bạn không thấy nút nổi đâu.
2. **Nút nổi** — hình tròn có cây bút, mặc định nằm ở mép phải phía trên ô nhập. Kéo được sang chỗ
   khác, vị trí sẽ được nhớ. Tắt/bật bằng biểu tượng ◉ ở góc trên bên phải của bảng.

Mở bảng rồi thì bấm **⚙** ở đáy thanh bên trái để vào Thiết lập.

> Bản gốc để nút nổi ở độ mờ 45% và chỉ rõ lại khi rê chuột lên — nghĩa là trên điện thoại nó
> **không bao giờ rõ**, chìm hẳn vào nền và rất dễ tưởng là mất nút. Bản Việt hóa này đã chỉnh lại
> cho nút hiện rõ trên thiết bị cảm ứng.

---

## Dấu thời gian — nền móng của cả tiện ích

Mặc định **bật**. Tiện ích tiêm cho AI ở tầng chính một đoạn chỉ dẫn, buộc nó đóng ở đầu và cuối nội
dung mỗi tầng một dấu thời gian dạng chú thích HTML:

```
<!-- SDC-start Thứ Hai, 15/3, 8 giờ sáng -->…nội dung truyện…<!-- SDC-end 15/3, 11 giờ đêm -->
```

SillyTavern không hiển thị chú thích HTML nên bạn không thấy gì trong khung chat, nhưng tiện ích
đọc ngược lại được để biết «bây giờ là lúc nào», chính xác tới **giờ**. Trục, Điểm, thước đo đều
lấy đây làm nguồn thời gian.

Nếu tắt (hoặc AI quên đóng dấu), tiện ích lùi về chuỗi sáu lớp đỡ: mốc ghim tay → BaiBaiBook → kho
ký ức → Tuyến → Điểm → **quét ngày ghi trong chính văn** → cuối cùng mới là 1/1. Lớp quét chính văn
trong bản Việt hóa nhận được `15/3`, `21/09/2018`, `ngày 21 tháng 9`, `Ngày thứ mười hai`… nên hầu
như không bao giờ phải rơi xuống 1/1 nữa.

Thiết lập ở **Thiết lập → Thiết lập module → Dấu thời gian**, kèm ô sửa lại nguyên đoạn lời nhắc nếu
bạn muốn tự viết.

---

## Thước đo (sổ ngầm)

Nằm ở trang thứ ba của bảng **Trục**. Đây là cuốn sổ theo dõi những thứ **đổi trạng thái theo thời
gian**, gồm ba loại:

- **Trạng thái kéo dài** — thương tích, bệnh tật, mang thai, cảm xúc còn dai dẳng (vết cắt → lên da
  non → lành hẳn).
- **Hẹn cần làm** — việc đã hẹn sẽ làm, có hay không có ngày cụ thể đều ghi.
- **Chu kỳ** — việc lặp lại đều đặn (kinh nguyệt, lĩnh lương, trực ca), kèm số ngày chu kỳ.

Cách nó chạy: **CODE tính ngày, AI chỉ hạ kết luận.** Tiện ích tự tính «đã qua bao nhiêu ngày» rồi
mới đút cho AI, nên không phải nhờ mô hình trừ ngày (thứ nó vốn rất dở).

Mỗi mục thao tác riêng được: **khóa** (AI không đụng vào nữa), **tạm dừng chôn** (vẫn theo dõi nhưng
tạm không tiêm vào tầng chính), **kết thúc** (lưu trữ, vớt lại được), **sửa**.

Cả phần tự đánh dấu lẫn phần tiêm ngầm đều **mặc định tắt** (mỗi cái thêm một luồng API chạy nền) —
bật ở **Thiết lập → Thiết lập module → Trục**.

---

## Du hành thời gian

Trong lịch tháng của **Trục**, bấm vào một ngày rồi chọn **Nhảy tới ngày này**. Tiện ích sẽ soạn sẵn
vào ô nhập một đoạn mô tả bước nhảy thời gian (bạn chọn hướng: đời thường / trưởng thành / ngọt ngào
/ bi kịch / tự viết, hoặc để AI suy diễn ba phương án cho bạn chọn), rồi sau khi AI trả lời sẽ đồng
bộ lại Điểm, Tuyến, Diện và thước đo về mốc thời gian mới.

---

## Thiết lập API

Vào **Thiết lập → Thiết lập cơ bản → API** trong bảng của tiện ích.

- **Để trống**: tiện ích dùng luôn mô hình hiện tại của SillyTavern. Nhược điểm là trong lúc tạo nội
  dung nó **chiếm kênh trò chuyện**, bạn không vừa tạo vừa chat được.
- **Điền API riêng** (Base URL + Key + tên mô hình): mọi thứ chạy nền, không đụng tới cuộc trò
  chuyện của bạn. Đây là cách nên dùng.

Vài tùy chọn đáng chú ý:

- **Thiết lập sẵn API** — lưu nhiều bộ cấu hình có tên rồi chuyển qua lại. Bấm ＋ để lưu bộ đang
  điền, bấm ✎ để đổi tên.
- **Tách luồng tác vụ máy móc** — định tuyến những lời gọi «máy móc» (tóm tắt ký ức, phán định ngày,
  phán định đẩy tiến đại cương) sang một mô hình nhỏ rẻ tiền, còn phần sinh nội dung chính thức vẫn
  đi API chính. Tiết kiệm đáng kể nếu bạn bật ký ức tự động.
- **Loại bỏ tham số** — nếu API của bạn trả lỗi 400 vì không nhận một tham số nào đó
  (hay gặp: `frequency_penalty` với các proxy Gemini), điền tên tham số đó vào đây.
- **Thời gian chờ / Truyền theo dòng** — nếu hay gặp `socket hang up`, tăng thời gian chờ hoặc bật
  truyền theo dòng.

Tiện ích tự thử lại 2 lần theo lối lùi dần khi gặp 429 / 5xx / mạng chập chờn, nên những cú giới hạn
tốc độ ngẫu nhiên thường tự lành.

---

## Ký ức câu chuyện

Tiện ích tự tóm tắt cuộc trò chuyện thành hai tầng để làm tư liệu cho mọi module:

- **L0** — cứ 5 tầng AI thì gộp thành một đoạn tóm tắt khách quan (mốc thời gian, bối cảnh, sự kiện,
  nhân vật).
- **L1** — cứ 10 đoạn L0 thì nén thành một chương.

Bản tóm tắt lưu kèm file trò chuyện, không chiếm cache trình duyệt. Tầng mới nhất không bao giờ
được tóm tắt để tránh việc roll lại nhiều lần làm hỏng dữ liệu.

Ngoài hệ có sẵn, bạn có thể đổi sang nguồn ký ức ngoài: **BaiBaiBook**, **Anima**, hoặc **cơ sở dữ
liệu** của TavernHelper. Có mức trần token cho khối ký ức (mặc định 60k) — vượt thì nén lại rồi mới
tiêm, chứ không làm vỡ ngữ cảnh.

> **Mẹo**: nếu bản tóm tắt cứ trống, phần lớn là do thẻ nhân vật bọc toàn bộ nội dung trong thẻ tùy
> chỉnh (ví dụ `<gametxt>`). Vào **Thiết lập → Thiết lập nâng cao → Dọn thẻ → Giữ lại phần bao** thêm
> tên thẻ đó vào.

---

## Những thứ chèn vào khung trò chuyện

Gom vào **Thiết lập → Thiết lập cơ bản → Quản lý hiển thị và thông báo**. Từ bản 3.x, Lịch/Điểm/
Tuyến/kho đánh dấu đã gộp chung vào **một bảng điều khiển gấp được** ở đáy tầng AI, thu lại chỉ còn
một thanh nhỏ «Nay 15/3 T2 ☀ · Trục 8 Điểm 5 Tuyến 3».

Các phần **chỉ đọc**, không tiêm vào AI, không gọi API — tắt đi chỉ là không hiển thị:

- Khu **Điểm** (việc cần làm hôm nay) · **Tuyến** (tuyến đang hoạt động) · **Trục** (bảy ngày tới)
- **Kho đánh dấu** ở tầng AI và **Gọi lại** ở tầng người dùng
- Nút **Lưu tầng này** cạnh tên nhân vật ở mỗi tầng
- **Kết xuất ngược lên tối đa N tầng** — mặc định đi theo trợ lý của SillyTavern; càng nhiều tầng
  càng tốn hiệu năng nên có cửa sổ kết xuất theo tầm nhìn.

Riêng ba thứ sau thì **có** tác động tới AI và mặc định tắt, bạn tự bật nếu muốn:

- **Tiêm ngầm Tuyến** — đưa các phục bút đang hoạt động vào ngữ cảnh một cách vô hình.
- **Tự tiêm đại cương** — cứ mỗi N tầng lại phán định độc lập xem cốt truyện tới nút nào. Con trỏ chỉ
  tiến không lùi, không có tín hiệu thì không nhúc nhích.
- **Tiêm ngầm thước đo** — chọn vài khoản sổ liên quan nhất lúc này rồi chôn vào ngữ cảnh, để AI nhớ
  vết thương / lời hẹn / chu kỳ của nhân vật mà thể hiện đúng theo số ngày.

Cả ba đều nằm dưới **cầu dao tiêm tổng** ở đầu trang thiết lập — tắt cầu dao là không cái nào tiêm.

---

## Dữ liệu được lưu ở đâu

| Nơi lưu | Nội dung | Đặc điểm |
| --- | --- | --- |
| `chat_metadata` (theo file trò chuyện) | Điểm, Tuyến, Diện, thảo luận Diện, Gian, Trục, lịch pháp, thước đo, ký ức, lớp vĩnh viễn của Lăng | Đi theo file chat xuống máy chủ — đổi trình duyệt, xóa cache đều không mất |
| `message.extra` của từng tầng | Bản chụp Điểm/Tuyến/Trục/kho đánh dấu «lúc bấy giờ» của tầng đó | Cho phép cuộn ngược lên xem đúng trạng thái của tầng cũ, chỉ đọc |
| `/api/files` trên máy chủ | Tọa Độ (các tầng đã lưu) | Toàn cục, dùng chung mọi thiết bị, theo tài khoản ST |
| Sách thế giới chuyên dụng | Kho mẫu của Lăng | Toàn cục, **tuyệt đối không bao giờ được tiêm vào AI** |
| `extension_settings` | Thiết lập sẵn API, mẫu lịch pháp, danh sách loại trừ sách thế giới | Toàn cục theo tài khoản ST |
| `localStorage` | Bản nháp Lăng + vị trí/kích thước bảng | Gắn với thiết bị, không đồng bộ |

Xem và dọn dẹp toàn bộ ở **Thiết lập → Thiết lập nâng cao → Quản lý lưu trữ**. Tiện ích chỉ thống kê
và xóa dữ liệu của chính nó, không bao giờ đụng vào dữ liệu của plugin khác.

---

## Khóa để giữ nội dung

Điểm, Tuyến, Trục và thước đo đều có nút khóa 🔒. Mục đã khóa sẽ **được giữ nguyên** khi AI tạo lại —
kể cả khi AI xóa mất nó, tiện ích cũng gộp lại theo tên. Dùng khi bạn ưng một mục nào đó và không
muốn nó bị lượt tạo sau cuốn trôi.

Ngày bạn tự nhập vào Trục mặc định đã được khóa sẵn. Mục thước đo bạn tự sửa cũng tự khóa.

---

## Về bản Việt hóa

Ngoài phần dịch chuỗi, lời nhắc và toàn bộ chú thích mã nguồn, bản này còn chỉnh lại những chỗ vốn
chỉ hợp chữ Hán:

**Giao diện**

- Nhãn tab thanh bên trước đây dựng **dọc** kiểu gáy sách (đẹp với một chữ Hán, nhưng chữ Latinh sẽ
  xếp chồng từng chữ cái và vỡ dấu) — nay chuyển sang nằm ngang, bỏ giãn chữ, thanh bên nới từ 44px
  lên 58px, chiều cao dòng nới ra cho dấu chồng (ố, ộ, ằ) khỏi bị cắt.
- Phông mặc định đổi từ Nowar Rounded TW (phông Trung, không phủ đủ dấu tiếng Việt) sang **Nunito**
  trên Google Fonts; chồng phông đỡ phía sau cũng đảo lại, phông Latinh phủ đủ dấu lên trước, phông
  CJK lùi xuống cuối.
- Nút nổi: nâng độ đục 0.45 → 0.72, viền dày và đậm hơn, thêm nền mờ nhạt, và **rõ hẳn trên máy cảm
  ứng** (`@media (hover: none)`) vì ở đó không có `:hover` để nó sáng lên.
- Nhãn tab ngày («Tương lai», «Ngày thứ 3») cắt bằng dấu ba chấm thay vì tràn ra ngoài.

**Ngày tháng và ngôn ngữ**

- Ngày tháng hiển thị theo lối **ngày/tháng**; thứ dùng dạng ngắn CN/T2…T7 cho lưới lịch, có sẵn
  dạng đầy đủ (Chủ nhật, Thứ hai…) cho các dòng chi tiết.
- Bộ giải ngày nhận thêm `dd/mm/yyyy`, `ngày D tháng M [năm Y]`, và `Ngày thứ N` kể cả khi số viết
  bằng chữ («ngày thứ mười hai», «ngày thứ hai mươi mốt»). Các nhánh tiếng Việt đặt **trước** mẫu
  `YYYY/M/D` để `21/09/2018` không bị đọc nhầm thành năm 21.
- Bộ nhận thứ trong tuần hiểu «thứ hai», «chủ nhật», «T5», và bắt được thứ nằm sát ngày theo **cả hai
  chiều**, vì thanh trạng thái tiếng Việt hay viết thứ **trước** ngày («Thứ Hai, 15/3»).
- Bộ nhận thời tiết hiểu nắng / mưa / mưa dông / tuyết / sương mù / nhiều mây / âm u / gió.
- Bộ tách từ khóa cho phần gợi nhớ ký ức ghép thêm cặp hai tiếng liền nhau, vì phần lớn từ tiếng
  Việt là từ ghép hai âm tiết («vết thương», «kinh nguyệt») — so từng tiếng lẻ thì trúng rất kém.
- Bộ lễ tết mẫu trong lời nhắc tạo Trục đổi sang lễ tết Việt Nam (Tết Nguyên đán, Giỗ Tổ Hùng Vương,
  30/4 – 1/5, Tết Đoan ngọ, Trung thu, 20/11, …) và AI được dặn phải **phán vùng văn hóa trước** rồi
  mới rải lễ tết tương ứng.

**Sửa lỗi kèm theo**

- Lịch tháng của Trục nay **bám theo «hôm nay»** cho tới khi bạn tự lật tháng. Bản gốc cache đúng một
  lần cả phiên, nên diễn biến sang tháng mới mà lịch vẫn đứng ở tháng cũ.
- Điểm tiêm vào ô nhập nay mang theo cả ngày tháng, không còn chỉ có mỗi giờ.

Các nhãn dữ liệu (giai đoạn của Tuyến, loại mục thước đo, hành động phán định, tiêu đề ngày) được
dịch **đồng bộ ở cả nơi AI sinh ra lẫn nơi mã nguồn phân tích**, đồng thời vẫn giữ lớp đỡ đọc được
nhãn tiếng Trung cũ — nên dữ liệu tạo từ bản trước không bị hỏng, và thẻ nhân vật viết bằng tiếng
Trung vẫn dùng được.

Thư mục `debug-sessions/` là nhật ký phát triển của tác giả gốc, giữ nguyên tiếng Trung, không ảnh
hưởng gì tới việc chạy tiện ích.

---

## Ghi công

- Mã nguồn gốc: [atonal519/ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal)
- Biểu tượng nút nổi: Solar «pen-new-round-outline» (giấy phép MIT)
- Phông chữ mặc định: [Nunito](https://fonts.google.com/specimen/Nunito) (giấy phép SIL Open Font)
- Lời nhắc phá giới hạn mặc định lấy từ ST-BaiBai-Book (đã được tác giả cho phép)
