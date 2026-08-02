# Lịch Trình

Tiện ích mở rộng cho [SillyTavern](https://github.com/SillyTavern/SillyTavern) giúp bạn phác họa và
theo dõi câu chuyện nhập vai của mình: lịch trình nhân vật, phục bút, đại cương, lịch lễ tết, ngoại
truyện và tủ lưu những khoảnh khắc đáng nhớ.

Đây là **bản Việt hóa** của [`atonal519/ST-SevenDaysCal`](https://github.com/atonal519/ST-SevenDaysCal)
(构画), phiên bản 2.4.1 — dịch đầy đủ giao diện, lời nhắc gửi cho AI và chú thích mã nguồn.

---

## Sáu module

Tiện ích được tổ chức theo một hệ hình học: **Điểm · Tuyến · Diện · Gian · Lăng · Tọa Độ**, cộng thêm
**Lịch**. Mỗi module là một tab ở thanh bên trái.

| Module | Là gì | Dùng khi nào |
| --- | --- | --- |
| **Điểm** (lịch trình) | Thẻ việc cần làm và trạng thái gần đây theo góc nhìn Tôi hoặc TA. AI đọc cốt truyện rồi suy ra ai đang làm gì, sắp có lịch gì, tâm trạng và vị trí. | Muốn nắm nhanh «bây giờ ai đang ở đâu, sắp làm gì». |
| **Tuyến** (tuyến sự kiện) | Theo dõi phục bút và mạch ngầm — những nút thắt đã gieo mà chưa thu lại. Tự tiến theo nhịp bạn đặt. | Kể chuyện dài hơi, sợ quên mất phục bút đã cài. |
| **Diện** (đại cương) | Bảng nhịp của cả câu chuyện, chia thành 6–8 nút, đánh dấu «đang diễn tới đâu, bước kế đi đâu». | Muốn câu chuyện có xương sống, không lạc đề. |
| **Gian** (trò chuyện ngoài lề) | Không gian nói chuyện với AI ngoài vai diễn: bàn cốt truyện, thiết định, quan hệ, kiến thức. Không lọt vào cuộc trò chuyện chính. | Cần bàn riêng với «đạo diễn». |
| **Lăng** (tiểu kịch trường) | Cho AI viết một truyện ngắn / ngoại truyện độc lập dựa trên bối cảnh hiện tại, có làm đẹp bố cục. | Muốn xem «nếu… thì sao». |
| **Tọa Độ** (tầng đã lưu) | Lưu bản chụp nguyên vẹn một tầng tin nhắn (kèm kiểu dáng lúc đó), phân loại theo nhân vật / cuộc trò chuyện / nhãn. | Đánh dấu cảnh kinh điển để đọc lại. |
| **Lịch** (lịch pháp) | Lịch lễ tết, sinh nhật, ngày kỷ niệm của thế giới quan. Tự tính thứ, đánh dấu ngày sắp tới. | Muốn cốt truyện hô ứng với lễ tết trong thiết định. |

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

> Bản gốc 2.4.1 để nút nổi ở độ mờ 45% và chỉ rõ lại khi rê chuột lên — nghĩa là trên điện thoại nó
> **không bao giờ rõ**, chìm hẳn vào nền tối và rất dễ tưởng là mất nút. Bản Việt hóa này đã chỉnh lại
> cho nút hiện rõ trên thiết bị cảm ứng.

---

## Thiết lập API

Vào **Thiết lập → API** trong bảng của tiện ích.

- **Để trống**: tiện ích dùng luôn mô hình hiện tại của SillyTavern. Nhược điểm là trong lúc tạo nội
  dung nó **chiếm kênh trò chuyện**, bạn không vừa tạo vừa chat được.
- **Điền API riêng** (Base URL + Key + tên mô hình): mọi thứ chạy nền, không đụng tới cuộc trò
  chuyện của bạn. Đây là cách nên dùng.

Vài tùy chọn đáng chú ý:

- **Thiết lập sẵn API** — lưu nhiều bộ cấu hình có tên rồi chuyển qua lại. Bấm ＋ để lưu bộ đang
  điền, bấm ✎ để đổi tên.
- **Thiết lập sẵn cho tác vụ máy móc** — định tuyến những lời gọi «máy móc» (tóm tắt ký ức, phán định
  đẩy tiến đại cương) sang một mô hình nhỏ rẻ tiền, còn phần sinh nội dung chính thức vẫn đi API
  chính. Tiết kiệm đáng kể nếu bạn bật ký ức tự động.
- **Tham số loại bỏ** — nếu API của bạn trả lỗi 400 vì không nhận một tham số nào đó
  (hay gặp: `frequency_penalty` với các proxy Gemini), điền tên tham số đó vào đây.
- **Thời gian chờ / Truyền theo dòng** — nếu hay gặp `socket hang up`, tăng thời gian chờ hoặc bật
  truyền theo dòng.

---

## Ký ức câu chuyện

Tiện ích tự tóm tắt cuộc trò chuyện thành hai tầng để làm tư liệu cho mọi module:

- **L0** — cứ 5 tầng AI thì gộp thành một đoạn tóm tắt khách quan (mốc thời gian, bối cảnh, sự kiện,
  nhân vật).
- **L1** — cứ 10 đoạn L0 thì nén thành một chương.

Bản tóm tắt lưu kèm file trò chuyện, không chiếm cache trình duyệt. Tầng mới nhất không bao giờ
được tóm tắt để tránh việc roll lại nhiều lần làm hỏng dữ liệu.

Nếu bạn đã dùng **BaiBaiBook (ST-BaiBai-Book)**, có thể bật «Dùng BaiBaiBook làm nguồn ký ức» để lấy
lịch sử từ đó thay vì chạy hệ thống có sẵn.

> **Mẹo**: nếu bản tóm tắt cứ trống, phần lớn là do thẻ nhân vật bọc toàn bộ nội dung trong thẻ tùy
> chỉnh (ví dụ `<gametxt>`). Vào **Thiết lập → Thẻ và lời nhắc → Giữ lại phần bao** thêm tên thẻ đó vào.

---

## Những thứ chèn vào khung trò chuyện

Ba phần hiển thị **chỉ đọc**, gom vào **Thiết lập → Quản lý hiển thị**. Cả ba đều không tiêm vào AI
và không gọi API — tắt đi chỉ là không hiển thị:

- Khối **Tuyến** ở đáy tầng AI mới nhất
- Thanh **Lịch · lịch trình** (bảy ngày tới) ở đáy tầng AI mới nhất
- Nút **Lưu tầng này** cạnh tên nhân vật ở mỗi tầng

Riêng hai thứ sau thì **có** tác động tới AI và mặc định tắt, bạn tự bật nếu muốn:

- **Tiêm ngầm Tuyến** — đưa các phục bút đang hoạt động vào ngữ cảnh một cách vô hình, để AI coi
  chúng như mạch ngầm mà đẩy tiến chậm rãi.
- **Tự tiêm đại cương** — cứ mỗi N tầng lại phán định độc lập xem cốt truyện tới nút nào, rồi ngầm
  dẫn AI đi theo đại cương. Con trỏ chỉ tiến không lùi, không có tín hiệu thì không nhúc nhích.

---

## Dữ liệu được lưu ở đâu

| Nơi lưu | Nội dung | Đặc điểm |
| --- | --- | --- |
| `chat_metadata` (theo file trò chuyện) | Điểm, Tuyến, Diện, thảo luận Diện, Gian, Lịch, ký ức, lớp vĩnh viễn của Lăng | Đi theo file chat xuống máy chủ — đổi trình duyệt, xóa cache đều không mất |
| `/api/files` trên máy chủ | Tọa Độ (các tầng đã lưu) | Toàn cục, dùng chung mọi thiết bị, theo tài khoản ST |
| Sách thế giới chuyên dụng | Kho mẫu của Lăng (`PhacHoa-Lang-Mau-Tieu-Kich-Truong`) | Toàn cục, **tuyệt đối không bao giờ được tiêm vào AI** |
| `localStorage` | Bản nháp Lăng + vị trí/kích thước bảng | Gắn với thiết bị, không đồng bộ |

Xem và dọn dẹp toàn bộ ở **Thiết lập → Quản lý lưu trữ**. Tiện ích chỉ thống kê và xóa dữ liệu của
chính nó, không bao giờ đụng vào dữ liệu của plugin khác.

Người dùng bản cũ (1.x) không cần làm gì: lần đầu mở lại mỗi cuộc trò chuyện, dữ liệu trong
`localStorage` sẽ tự được dời sang `chat_metadata`. Nếu phát hiện máy bạn và máy chủ mỗi bên một bản
khác nhau, tiện ích sẽ hỏi bạn giữ bản nào chứ không tự ý ghi đè.

---

## Khóa để giữ nội dung

Điểm, Tuyến và Lịch đều có nút khóa 🔒. Mục đã khóa sẽ **được giữ nguyên** khi AI tạo lại — kể cả
khi AI xóa mất nó, tiện ích cũng gộp lại theo tên. Dùng khi bạn ưng một mục nào đó và không muốn nó
bị lượt tạo sau cuốn trôi.

Ngày bạn tự nhập vào Lịch mặc định đã được khóa sẵn.

---

## Về bản Việt hóa

Ngoài phần dịch chuỗi và lời nhắc, bản này còn chỉnh lại vài chỗ giao diện vốn chỉ hợp chữ Hán:

- Nhãn tab thanh bên trước đây dựng **dọc** kiểu gáy sách (đẹp với một chữ Hán, nhưng chữ Latinh sẽ
  xếp chồng từng chữ cái và mất dấu) — nay chuyển sang nằm ngang, thanh bên nới từ 44px lên 58px.
- Bộ phông đảo lại: phông Latinh phủ đủ dấu tiếng Việt lên trước, phông CJK lùi xuống làm lớp dự phòng.
- Ngày tháng hiển thị theo lối **ngày/tháng**; thứ dùng dạng ngắn CN/T2…T7 cho lưới lịch và tên đầy
  đủ cho các dòng chi tiết.
- Lời nhắc làm đẹp của Lăng nâng chiều cao dòng lên 1.7 và cấm giãn chữ, vì dấu thanh tiếng Việt cần
  khoảng hở dọc rộng hơn.
- Bộ lễ tết mẫu trong lời nhắc tạo Lịch đổi sang lễ tết Việt Nam (Tết Nguyên đán, Giỗ Tổ Hùng Vương,
  30/4 – 1/5, Tết Trung thu, 20/11, …).

Các nhãn dữ liệu (giai đoạn của Tuyến, tiêu đề ngày, trường ký ức) được dịch **đồng bộ ở cả nơi AI
sinh ra lẫn nơi mã nguồn phân tích**, đồng thời vẫn giữ lớp đỡ đọc được nhãn tiếng Trung cũ — nên dữ
liệu tạo từ bản trước không bị hỏng.

Thư mục `debug-sessions/` là nhật ký phát triển của tác giả gốc, giữ nguyên tiếng Trung, không ảnh
hưởng gì tới việc chạy tiện ích.

---

## Ghi công

- Mã nguồn gốc: [atonal519/ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal)
- Biểu tượng nút nổi: Solar «pen-new-round-outline» (giấy phép MIT)
- Lời nhắc phá giới hạn mặc định lấy từ ST-BaiBai-Book (đã được tác giả cho phép)
